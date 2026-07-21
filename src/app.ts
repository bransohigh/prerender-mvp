import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import { healthRoutes } from './routes/health.js';
import { renderRoutes } from './routes/render.js';
import { metricsRoutes } from './routes/metrics.js';
import { projectRoutes } from './routes/projects.js';
import { domainRoutes } from './routes/domains.js';
import { sitemapRoutes } from './routes/sitemaps.js';
import { renderUrl as defaultRenderUrl } from './services/renderer.js';
import { createCapacityController } from './services/render-capacity.js';
import { createRenderService } from './services/render-service.js';
import { createProjectService } from './services/project-service.js';
import { createDomainService } from './services/domain-service.js';
import { metrics as defaultMetrics, type Metrics } from './lib/metrics.js';
import { createDbClient, type DbClient } from './db/client.js';
import { createDbReadinessCheck } from './db/readiness.js';
import { createPostgresProjectRepository } from './repositories/postgres/postgres-project-repository.js';
import { createPostgresDomainRepository } from './repositories/postgres/postgres-domain-repository.js';
import { createPostgresSitemapRepository } from './repositories/postgres/postgres-sitemap-repository.js';
import { createPostgresDiscoveredUrlRepository } from './repositories/postgres/postgres-discovered-url-repository.js';
import type {
  ProjectRepository,
  DomainRepository,
  SitemapRepository,
  DiscoveredUrlRepository,
} from './repositories/types.js';
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
  // Repository injection point for tests (fake in-memory implementations).
  // When any of these is provided, buildApp() does NOT construct a real
  // Postgres connection — all four must be provided together in that case.
  projectRepository?: ProjectRepository;
  domainRepository?: DomainRepository;
  sitemapRepository?: SitemapRepository;
  discoveredUrlRepository?: DiscoveredUrlRepository;
  // Overrides the /readyz database check directly (tests that don't care
  // about DB behavior can pass `async () => true`).
  checkDatabaseReady?: () => Promise<boolean>;
}

// Client-supplied request IDs are only trusted if they look like a UUID/
// opaque token — short, ASCII, no injection surface for log forging. Any
// value that doesn't match falls back to a server-generated UUID.
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export async function buildApp(options?: AppOptions) {
  const rawRenderUrl = options?.renderUrl ?? defaultRenderUrl;
  const metrics = options?.metrics ?? defaultMetrics;

  const injectedRepos =
    options?.projectRepository && options?.domainRepository &&
    options?.sitemapRepository && options?.discoveredUrlRepository;

  let dbClient: DbClient | null = null;
  let projectRepository: ProjectRepository;
  let domainRepository: DomainRepository;
  let sitemapRepository: SitemapRepository;
  let discoveredUrlRepository: DiscoveredUrlRepository;
  let checkDatabaseReady: () => Promise<boolean>;

  if (injectedRepos) {
    projectRepository = options.projectRepository!;
    domainRepository = options.domainRepository!;
    sitemapRepository = options.sitemapRepository!;
    discoveredUrlRepository = options.discoveredUrlRepository!;
    checkDatabaseReady = options?.checkDatabaseReady ?? (async () => true);
  } else {
    dbClient = createDbClient(env.DATABASE_URL);
    projectRepository = createPostgresProjectRepository(dbClient.db);
    domainRepository = createPostgresDomainRepository(dbClient.db);
    sitemapRepository = createPostgresSitemapRepository(dbClient.db);
    discoveredUrlRepository = createPostgresDiscoveredUrlRepository(dbClient.db);
    checkDatabaseReady = options?.checkDatabaseReady ?? createDbReadinessCheck(dbClient);
  }

  const projectService = createProjectService(projectRepository);
  const domainService = createDomainService(domainRepository);

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
          'req.headers["x-admin-api-key"]',
          'req.headers["x-render-api-key"]',
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
    isReady: async () =>
      !capacity.getSnapshot().closed &&
      !shuttingDown &&
      (!env.REQUIRE_OUTBOUND_PROXY || !!env.OUTBOUND_PROXY_URL) &&
      (await checkDatabaseReady()),
  });
  await app.register(metricsRoutes, { metrics });
  await app.register(renderRoutes, {
    prefix: '/v1',
    renderUrl: service.renderUrl,
    domainRepository,
    metrics,
    getCapacitySnapshot: () => {
      const snapshot = service.getSnapshot();
      return { activeRenders: snapshot.active, queuedRenders: snapshot.queued };
    },
  });
  await app.register(projectRoutes, { prefix: '/v1', projectService });
  await app.register(domainRoutes, {
    prefix: '/v1',
    projectService,
    domainService,
    domainRepository,
    sitemapRepository,
    metrics,
    proxyUrl: env.OUTBOUND_PROXY_URL,
  });
  await app.register(sitemapRoutes, {
    prefix: '/v1',
    sitemapRepository,
    discoveredUrlRepository,
    domainRepository,
    metrics,
    proxyUrl: env.OUTBOUND_PROXY_URL,
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
    if (dbClient) {
      await dbClient.close();
    }
  });

  return app;
}
