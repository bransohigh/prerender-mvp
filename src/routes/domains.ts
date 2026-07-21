import type { FastifyPluginAsync } from 'fastify';
import { registerMigratedEndpoint } from './legacy-migrated.js';

// All unscoped domain management endpoints have moved to the
// organization-scoped route tree (src/routes/organizations.ts) — see
// TENANCY.md. Permanently 410; never re-authenticates via ADMIN_API_KEY.
export interface DomainRouteOptions {
  // Kept for backward-compatible call-site shape in src/app.ts during the
  // transition; unused by the 410 stubs.
  projectService?: unknown;
  domainService?: unknown;
  domainRepository?: unknown;
  sitemapRepository?: unknown;
  metrics?: unknown;
  proxyUrl?: string;
}

export const domainRoutes: FastifyPluginAsync<DomainRouteOptions> = async (app) => {
  registerMigratedEndpoint(
    app,
    'POST',
    '/projects/:projectId/domains',
    'POST /v1/organizations/:organizationId/projects/:projectId/domains',
  );
  registerMigratedEndpoint(
    app,
    'GET',
    '/projects/:projectId/domains',
    'GET /v1/organizations/:organizationId/projects/:projectId/domains',
  );
  registerMigratedEndpoint(app, 'GET', '/domains/:domainId', 'GET /v1/organizations/:organizationId/domains/:domainId');
  registerMigratedEndpoint(
    app,
    'POST',
    '/domains/:domainId/rotate-verification-token',
    'POST /v1/organizations/:organizationId/domains/:domainId/rotate-verification-token',
  );
  registerMigratedEndpoint(
    app,
    'POST',
    '/domains/:domainId/verify',
    'POST /v1/organizations/:organizationId/domains/:domainId/verify',
  );
  registerMigratedEndpoint(
    app,
    'POST',
    '/domains/:domainId/discover-sitemaps',
    'POST /v1/organizations/:organizationId/domains/:domainId/discover-sitemaps',
  );
};
