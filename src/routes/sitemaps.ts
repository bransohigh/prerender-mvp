import type { FastifyPluginAsync } from 'fastify';
import { AppError, isAppError } from '../lib/app-error.js';
import { createApiKeyGuard } from '../lib/api-key-auth.js';
import { env } from '../config/env.js';
import { fetchAndParseSitemapSource } from '../services/sitemap-fetch-service.js';
import type { DiscoveredUrlRepository, DomainRepository, SitemapRepository } from '../repositories/types.js';
import { createNoopMetrics, type Metrics } from '../lib/metrics.js';

export interface SitemapRouteOptions {
  sitemapRepository: SitemapRepository;
  discoveredUrlRepository: DiscoveredUrlRepository;
  domainRepository: DomainRepository;
  metrics?: Metrics;
  proxyUrl?: string;
}

export const sitemapRoutes: FastifyPluginAsync<SitemapRouteOptions> = async (app, opts) => {
  const { sitemapRepository, discoveredUrlRepository, domainRepository } = opts;
  const metrics = opts.metrics ?? createNoopMetrics();

  const requireAdmin = createApiKeyGuard({
    headerName: 'x-admin-api-key',
    expectedKey: env.ADMIN_API_KEY,
    errorMessage: 'invalid_admin_api_key',
  });
  app.addHook('preHandler', requireAdmin);

  app.post('/sitemap-sources/:sourceId/fetch', async (request, reply) => {
    const { sourceId } = request.params as { sourceId: string };
    try {
      const source = await sitemapRepository.findById(sourceId);
      if (!source) {
        throw new AppError('SITEMAP_SOURCE_NOT_FOUND', `Sitemap source not found: ${sourceId}`);
      }
      const domain = await domainRepository.findById(source.domainId);
      if (!domain) {
        throw new AppError('DOMAIN_NOT_FOUND', 'Domain not found for sitemap source');
      }
      if (domain.status !== 'verified') {
        throw new AppError('DOMAIN_NOT_VERIFIED', 'Domain must be verified before fetching sitemaps');
      }

      const outcome = await fetchAndParseSitemapSource(
        domain,
        source,
        sitemapRepository,
        discoveredUrlRepository,
        { proxyUrl: opts.proxyUrl, metrics },
      );

      request.log.info(
        {
          event: 'sitemap_fetch_completed',
          domainId: domain.id,
          sitemapSourceId: sourceId,
          discoveredCount: outcome.discoveredCount,
        },
        'Sitemap fetch completed',
      );

      return reply.send({ sitemapSourceId: sourceId, discoveredCount: outcome.discoveredCount });
    } catch (err) {
      if (isAppError(err)) {
        request.log.warn(
          { event: 'sitemap_fetch_failed', sitemapSourceId: sourceId, errorCode: err.code },
          'Sitemap fetch failed',
        );
        return reply.code(err.statusCode).send({ error: err.code, message: err.message, requestId: request.id });
      }
      return reply.code(503).send({ error: 'DATABASE_UNAVAILABLE', requestId: request.id });
    }
  });
};
