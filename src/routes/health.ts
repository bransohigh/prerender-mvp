import type { FastifyPluginAsync } from 'fastify';

export interface HealthRouteOptions {
  isReady: () => boolean;
}

export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (
  app,
  opts,
) => {
  const { isReady } = opts;

  // Liveness/readiness checks are polled frequently by orchestrators — not
  // public API traffic — so they don't share the /v1/render rate limit budget.
  const noRateLimit = { config: { rateLimit: false } };

  // Liveness: only confirms the Node.js process is up and answering HTTP.
  // No I/O, no capacity checks, no browser interaction — must be fast and
  // never fail just because render capacity is exhausted.
  app.get('/livez', noRateLimit, async () => ({ status: 'ok' }));

  // Readiness: confirms the service can currently accept new render work.
  // Does NOT require a browser to already be open — Chromium launches
  // lazily on first render.
  app.get('/readyz', noRateLimit, async (_request, reply) => {
    if (!isReady()) {
      return reply.code(503).send({ status: 'not_ready' });
    }
    return { status: 'ready' };
  });

  // Backward-compatible alias for /livez. Deprecated — new integrations
  // should use /livez (process liveness) and /readyz (capacity readiness).
  app.get('/health', noRateLimit, async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));
};
