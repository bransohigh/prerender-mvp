import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import { healthRoutes } from './routes/health.js';
import { renderRoutes } from './routes/render.js';
import { renderUrl as defaultRenderUrl } from './services/renderer.js';
import { createCapacityController } from './services/render-capacity.js';
import { createRenderService } from './services/render-service.js';
import type { RenderFn } from './types/render.js';

export interface AppOptions {
  renderUrl?: RenderFn;
  maxConcurrentRenders?: number;
  maxQueuedRenders?: number;
  renderQueueTimeoutMs?: number;
}

export async function buildApp(options?: AppOptions) {
  const rawRenderUrl = options?.renderUrl ?? defaultRenderUrl;

  const capacity = createCapacityController({
    maxConcurrent: options?.maxConcurrentRenders ?? env.MAX_CONCURRENT_RENDERS,
    maxQueued: options?.maxQueuedRenders ?? env.MAX_QUEUED_RENDERS,
    queueTimeoutMs: options?.renderQueueTimeoutMs ?? env.RENDER_QUEUE_TIMEOUT_MS,
  });

  const service = createRenderService(rawRenderUrl, capacity);

  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    bodyLimit: 32 * 1024,
    trustProxy: false,
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

  await app.register(healthRoutes);
  await app.register(renderRoutes, { prefix: '/v1', renderUrl: service.renderUrl });

  app.addHook('onClose', async () => {
    service.close();
  });

  return app;
}
