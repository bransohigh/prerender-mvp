import type { FastifyPluginAsync } from 'fastify';
import { registerMigratedEndpoint } from './legacy-migrated.js';

// Unscoped sitemap-source fetch has moved conceptually under organization
// scope (domain discovery is now
// POST /v1/organizations/:organizationId/domains/:domainId/discover-sitemaps).
// A tenant-scoped equivalent of "fetch+parse a specific sitemap source" is
// not yet implemented — see TENANCY.md remaining-work notes; this endpoint
// is 410 rather than silently left reachable via the old global key.
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
