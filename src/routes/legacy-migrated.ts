import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// Registers a stable 410 Gone for an endpoint that has been migrated to the
// organization-scoped route tree (src/routes/organizations.ts). Never
// checks ADMIN_API_KEY or any other credential — the endpoint is gone
// regardless of what the caller presents, so there is no way to restore
// access to it via the old global key.
export function registerMigratedEndpoint(app: FastifyInstance, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, newRouteHint: string): void {
  app.route({
    method,
    url,
    handler: async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.code(410).send({
        error: 'ENDPOINT_MIGRATED',
        message: `This endpoint has moved. Use the organization-scoped route: ${newRouteHint}`,
      });
    },
  });
}
