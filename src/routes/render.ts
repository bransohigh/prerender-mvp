import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { isCapacityError } from '../lib/errors.js';
import { safeUrlOrigin } from '../lib/url-security.js';
import { normalizeTargetUrl, InvalidTargetUrlError } from '../lib/url-normalize.js';
import { checkApiKey } from '../lib/api-key-auth.js';
import { createNoopMetrics, safeMetricsCall, type Metrics } from '../lib/metrics.js';
import type { RenderFn } from '../types/render.js';
import type { DomainRepository } from '../repositories/types.js';

const renderBodySchema = z.object({
  domainId: z.string().uuid(),
  url: z.string().url().max(2048),
});

export interface RenderRouteOptions {
  renderUrl: RenderFn;
  domainRepository: DomainRepository;
  metrics?: Metrics;
  getCapacitySnapshot?: () => { activeRenders: number; queuedRenders: number };
}

export const renderRoutes: FastifyPluginAsync<RenderRouteOptions> = async (
  app,
  opts,
) => {
  const { renderUrl, domainRepository } = opts;
  const metrics = opts.metrics ?? createNoopMetrics();
  const getCapacitySnapshot = opts.getCapacitySnapshot ?? (() => ({ activeRenders: 0, queuedRenders: 0 }));

  app.post('/render', async (request, reply) => {
    const startedAt = Date.now();

    if (!checkApiKey(request.headers['x-render-api-key'], env.RENDER_API_KEY)) {
      safeMetricsCall(() => metrics.incrementRenderResult('unauthorized'));
      request.log.warn(
        { event: 'render_rejected', result: 'unauthorized' },
        'Render reddedildi: geçersiz API anahtarı',
      );
      return reply
        .code(401)
        .send({ error: 'Geçersiz API anahtarı', requestId: request.id });
    }

    const parsed = renderBodySchema.safeParse(request.body);
    if (!parsed.success) {
      safeMetricsCall(() => metrics.incrementRenderResult('validation_error'));
      request.log.info(
        { event: 'render_rejected', result: 'validation_error' },
        'Render reddedildi: geçersiz istek',
      );
      return reply.code(400).send({
        error: 'Geçersiz istek',
        details: parsed.error.flatten(),
        requestId: request.id,
      });
    }

    // --- Domain authorization (before capacity/renderer is touched) ---
    const domain = await domainRepository.findById(parsed.data.domainId);
    if (!domain) {
      safeMetricsCall(() => metrics.incrementRenderResult('validation_error'));
      request.log.info(
        { event: 'render_rejected', result: 'validation_error', errorCode: 'DOMAIN_NOT_FOUND', domainId: parsed.data.domainId },
        'Render reddedildi: domain bulunamadı',
      );
      return reply.code(404).send({ error: 'DOMAIN_NOT_FOUND', requestId: request.id });
    }
    if (domain.status !== 'verified') {
      safeMetricsCall(() => metrics.incrementRenderResult('validation_error'));
      request.log.info(
        { event: 'render_rejected', result: 'validation_error', errorCode: 'DOMAIN_NOT_VERIFIED', domainId: domain.id },
        'Render reddedildi: domain doğrulanmamış',
      );
      return reply.code(409).send({ error: 'DOMAIN_NOT_VERIFIED', requestId: request.id });
    }

    let normalized;
    try {
      normalized = normalizeTargetUrl(parsed.data.url, domain.normalizedHostname);
    } catch (err) {
      const code =
        err instanceof InvalidTargetUrlError && err.reason === 'host_mismatch'
          ? 'URL_DOMAIN_MISMATCH'
          : 'INVALID_RENDER_URL';
      safeMetricsCall(() => metrics.incrementRenderResult('validation_error'));
      request.log.info(
        { event: 'render_rejected', result: 'validation_error', errorCode: code, domainId: domain.id },
        'Render reddedildi: geçersiz hedef URL',
      );
      return reply.code(code === 'URL_DOMAIN_MISMATCH' ? 400 : 400).send({ error: code, requestId: request.id });
    }

    const safeOrigin = safeUrlOrigin(normalized.normalizedUrl);

    try {
      const result = await renderUrl(normalized.normalizedUrl);
      const durationMs = Date.now() - startedAt;
      // Approximation: total route time minus the browser's own render step.
      // Includes minor context/page setup overhead, not just capacity-queue
      // wait — the precise value is captured separately by the
      // prerender_queue_wait_duration_seconds histogram in render-capacity.ts.
      const queueWaitMs = Math.max(0, durationMs - result.renderTimeMs);
      safeMetricsCall(() => metrics.incrementRenderResult('success'));
      request.log.info(
        {
          event: 'render_completed',
          result: 'success',
          domainId: domain.id,
          renderTimeMs: result.renderTimeMs,
          queueWaitMs,
          totalTimeMs: durationMs,
          statusCode: result.statusCode,
          finalUrlOrigin: safeUrlOrigin(result.finalUrl),
          ...getCapacitySnapshot(),
        },
        'Render tamamlandı',
      );
      return result;
    } catch (error) {
      if (isCapacityError(error)) {
        const resultLabel =
          error.code === 'RENDER_QUEUE_FULL'
            ? 'queue_full'
            : error.code === 'RENDER_QUEUE_TIMEOUT'
              ? 'queue_timeout'
              : 'capacity_closed';
        safeMetricsCall(() => metrics.incrementRenderResult(resultLabel));
        request.log.warn(
          {
            event: 'render_rejected',
            result: resultLabel,
            errorCode: error.code,
            domainId: domain.id,
            requestUrlOrigin: safeOrigin,
            ...getCapacitySnapshot(),
          },
          'Render kapasite hatası',
        );
        return reply
          .code(503)
          .header('Retry-After', '5')
          .send({
            error: 'service_unavailable',
            code: error.code,
            message: error.message,
            requestId: request.id,
          });
      }

      safeMetricsCall(() => metrics.incrementRenderResult('render_error'));
      // Full error (including stack, via pino's default error serializer)
      // is logged server-side for operability — it never reaches the HTTP
      // response body below. requestUrlOrigin carries protocol+host+port
      // only, never path/query/fragment.
      request.log.error(
        {
          event: 'render_failed',
          result: 'render_error',
          domainId: domain.id,
          requestUrlOrigin: safeOrigin,
          error,
          ...getCapacitySnapshot(),
        },
        'Render işlemi başarısız',
      );
      const message = error instanceof Error ? error.message : 'Bilinmeyen hata';
      return reply.code(422).send({ error: message, requestId: request.id });
    }
  });
};
