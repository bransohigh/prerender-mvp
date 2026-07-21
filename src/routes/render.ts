import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { isCapacityError } from '../lib/errors.js';
import { safeUrlOrigin } from '../lib/url-security.js';
import { createNoopMetrics, safeMetricsCall, type Metrics } from '../lib/metrics.js';
import type { RenderFn } from '../types/render.js';

const renderBodySchema = z.object({
  url: z.string().url().max(2048),
});

export interface RenderRouteOptions {
  renderUrl: RenderFn;
  metrics?: Metrics;
  getCapacitySnapshot?: () => { activeRenders: number; queuedRenders: number };
}

export const renderRoutes: FastifyPluginAsync<RenderRouteOptions> = async (
  app,
  opts,
) => {
  const { renderUrl } = opts;
  const metrics = opts.metrics ?? createNoopMetrics();
  const getCapacitySnapshot = opts.getCapacitySnapshot ?? (() => ({ activeRenders: 0, queuedRenders: 0 }));

  app.post('/render', async (request, reply) => {
    const startedAt = Date.now();

    if (request.headers['x-api-key'] !== env.API_KEY) {
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

    const safeOrigin = safeUrlOrigin(parsed.data.url);

    try {
      const result = await renderUrl(parsed.data.url);
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
