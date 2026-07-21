import type { FastifyPluginAsync } from 'fastify';
import net from 'node:net';
import type { Metrics } from '../lib/metrics.js';

export interface MetricsRouteOptions {
  metrics: Metrics;
}

// Defense in depth only. The primary boundary is that renderer-api is
// published to 127.0.0.1 exclusively (see compose.hardened.yml) — it is
// never reachable from the public internet in this deployment topology.
// There is no separate public gateway in front of the app in this MVP; when
// one is added, it MUST also block /metrics at that layer (see
// docker/gateway/nginx.conf for a ready-to-use rule). This check rejects
// any request whose immediate TCP peer is not a private/loopback address,
// so a future misconfiguration that exposes the port publicly doesn't leak
// metrics by itself.
function isPrivateOrLoopback(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    return (
      ip === '127.0.0.1' ||
      ip.startsWith('10.') ||
      ip.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
    );
  }
  if (family === 6) {
    return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd');
  }
  return false;
}

export const metricsRoutes: FastifyPluginAsync<MetricsRouteOptions> = async (
  app,
  opts,
) => {
  const { metrics } = opts;

  // Not rate-limited: this is internal-only scrape traffic (Prometheus
  // typically polls every 10-30s), not public API traffic, and should not
  // share a budget with /v1/render callers.
  app.get(
    '/metrics',
    { config: { rateLimit: false } },
    async (request, reply) => {
      const remoteAddress = request.socket.remoteAddress ?? '';
      if (!isPrivateOrLoopback(remoteAddress)) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      const body = await metrics.getMetrics();
      return reply
        .header('content-type', metrics.getContentType())
        .header('cache-control', 'no-store')
        .send(body);
    },
  );
};
