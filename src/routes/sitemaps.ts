import type { FastifyPluginAsync } from 'fastify';
import { registerMigratedEndpoint } from './legacy-migrated.js';

// Replaced by the organization-scoped equivalent:
// POST /v1/organizations/:organizationId/sitemap-sources/:sourceId/fetch
// (src/routes/organizations.ts). Permanently 410; never re-authenticates
// via ADMIN_API_KEY.
export interface SitemapRouteOptions {
  sitemapRepository?: unknown;
  discoveredUrlRepository?: unknown;
  domainRepository?: unknown;
  metrics?: unknown;
  proxyUrl?: string;
}

export const sitemapRoutes: FastifyPluginAsync<SitemapRouteOptions> = async (app) => {
  registerMigratedEndpoint(
    app,
    'POST',
    '/sitemap-sources/:sourceId/fetch',
    'POST /v1/organizations/:organizationId/domains/:domainId/discover-sitemaps (fetch-by-source-id is not yet available in the tenant-scoped API)',
  );
};
