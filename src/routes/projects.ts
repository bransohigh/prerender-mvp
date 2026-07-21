import type { FastifyPluginAsync } from 'fastify';
import { registerMigratedEndpoint } from './legacy-migrated.js';

// All unscoped project management endpoints have moved to the
// organization-scoped route tree (src/routes/organizations.ts) — see
// TENANCY.md. Management now requires a browser session, never
// ADMIN_API_KEY, so these routes are permanently 410 rather than
// forwarding/re-authenticating a legacy credential.
export interface ProjectRouteOptions {
  // Kept for backward-compatible call-site shape in src/app.ts during the
  // transition; unused by the 410 stubs.
  projectService?: unknown;
}

export const projectRoutes: FastifyPluginAsync<ProjectRouteOptions> = async (app) => {
  registerMigratedEndpoint(app, 'POST', '/projects', 'POST /v1/organizations/:organizationId/projects');
  registerMigratedEndpoint(app, 'GET', '/projects', 'GET /v1/organizations/:organizationId/projects');
  registerMigratedEndpoint(app, 'GET', '/projects/:projectId', 'GET /v1/organizations/:organizationId/projects/:projectId');
  registerMigratedEndpoint(app, 'PATCH', '/projects/:projectId', 'PATCH /v1/organizations/:organizationId/projects/:projectId');
  registerMigratedEndpoint(app, 'DELETE', '/projects/:projectId', 'DELETE /v1/organizations/:organizationId/projects/:projectId');
};
