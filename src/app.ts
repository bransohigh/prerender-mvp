import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import { healthRoutes } from './routes/health.js';
import { renderRoutes } from './routes/render.js';
import { metricsRoutes } from './routes/metrics.js';
import { renderUrl as defaultRenderUrl } from './services/renderer.js';
import { createCapacityController } from './services/render-capacity.js';
import { createRenderService } from './services/render-service.js';
import { metrics as defaultMetrics, type Metrics } from './lib/metrics.js';
import type { RenderFn } from './types/render.js';

declare module 'fastify' {
  interface FastifyInstance {
    markShuttingDown: () => void;
  }
}

export interface AppOptions {
  renderUrl?: RenderFn;
  maxConcurrentRenders?: number;
  maxQueuedRenders?: number;
  renderQueueTimeoutMs?: number;
  metrics?: Metrics;
}

// Client-supplied request IDs are only trusted if they look like a UUID/
// opaque token — short, ASCII, no injection surface for log forging. Any
// value that doesn't match falls back to a server-generated UUID.
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export async function buildApp(options?: AppOptions) {
  const rawRenderUrl = options?.renderUrl ?? defaultRenderUrl;
  const metrics = options?.metrics ?? defaultMetrics;

  const capacity = createCapacityController({
    maxConcurrent: options?.maxConcurrentRenders ?? env.MAX_CONCURRENT_RENDERS,
    maxQueued: options?.maxQueuedRenders ?? env.MAX_QUEUED_RENDERS,
    queueTimeoutMs: options?.renderQueueTimeoutMs ?? env.RENDER_QUEUE_TIMEOUT_MS,
    metrics,
  });

  const service = createRenderService(rawRenderUrl, capacity);

  let shuttingDown = false;

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.headers["proxy-authorization"]',
        ],
        censor: '[redacted]',
      },
    },
    bodyLimit: 32 * 1024,
    trustProxy: false,
    requestIdHeader: false,
    genReqId: (request) => {
      const clientId = request.headers['x-request-id'];
      if (typeof clientId === 'string' && REQUEST_ID_PATTERN.test(clientId)) {
        return clientId;
      }
      return randomUUID();
    },
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });
  await app.register(cors, {
    origin: false,
  });
  await app.register(rateLimit, {
    max: 30,
    timeWindow: '1 minute',
  });

  await app.register(healthRoutes, {
    isReady: () => !capacity.getSnapshot().closed && !shuttingDown,
  });
  await app.register(metricsRoutes, { metrics });
  await app.register(renderRoutes, {
    prefix: '/v1',
    renderUrl: service.renderUrl,
    metrics,
    getCapacitySnapshot: () => {
      const snapshot = service.getSnapshot();
      return { activeRenders: snapshot.active, queuedRenders: snapshot.queued };
    },
  });

  // Callable before app.close() so /readyz reflects shutdown-in-progress
  // while the server may still be draining in-flight connections, rather
  // than only becoming accurate once the socket is already closed.
  app.decorate('markShuttingDown', () => {
    shuttingDown = true;
  });

  app.addHook('onClose', async () => {
    shuttingDown = true;
    service.close();
  });

  return app;
}
