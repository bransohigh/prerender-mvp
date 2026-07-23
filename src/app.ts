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
import { normalizeOriginForComparison } from './lib/csrf.js';
import { createDbClient, type DbClient } from './db/client.js';
import { createDbReadinessCheck } from './db/readiness.js';
import { createAuth, type Auth } from './auth/auth.js';
import { registerAuthRoutes } from './auth/plugin.js';
import { organizationRoutes } from './routes/organizations.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { createInvitationService } from './services/invitation-service.js';
import { createPostgresProjectRepository } from './repositories/postgres/postgres-project-repository.js';
import { createPostgresDomainRepository } from './repositories/postgres/postgres-domain-repository.js';
import { createPostgresSitemapRepository } from './repositories/postgres/postgres-sitemap-repository.js';
import { createPostgresDiscoveredUrlRepository } from './repositories/postgres/postgres-discovered-url-repository.js';
import { createPostgresAuditRepository } from './repositories/postgres/audit-repository.js';
import { createAuditService } from './services/audit-service.js';
import type {
  ProjectRepository,
  DomainRepository,
  SitemapRepository,
  DiscoveredUrlRepository,
} from './repositories/types.js';
import type { RenderFn } from './types/render.js';
import type { ApiKeyVerifier } from './services/render-api-key-auth-service.js';
import { createTenantRepository, type TenantRepository } from './repositories/postgres/tenant-repository.js';

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
  // Auth injection point for tests. When omitted and repositories are also
  // omitted (i.e. real Postgres path), buildApp() constructs the real
  // Better Auth instance from the same db connection.
  auth?: Auth;
  // Render-path injection points for fake-repo unit tests (real Postgres
  // path always uses the real `auth`/`createTenantRepository(dbClient.db)`
  // pair — these are ignored in that case).
  renderApiKeyVerifier?: ApiKeyVerifier;
  renderTenant?: Pick<TenantRepository, 'getOrganizationStatus' | 'getProjectForOrganization' | 'getDomainForOrganizationProject'>;
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

  // Auth is only mounted when a real (or explicitly injected) Better Auth
  // instance is available. Fake-repo tests that don't care about auth can
  // omit it entirely — /api/auth, /v1/organizations/*/invitations, and
  // /v1/onboarding/accept simply aren't registered in that case.
  let auth: Auth | null;

  if (injectedRepos) {
    projectRepository = options.projectRepository!;
    domainRepository = options.domainRepository!;
    sitemapRepository = options.sitemapRepository!;
    discoveredUrlRepository = options.discoveredUrlRepository!;
    checkDatabaseReady = options?.checkDatabaseReady ?? (async () => true);
    auth = options?.auth ?? null;
  } else {
    dbClient = createDbClient(env.DATABASE_URL);
    projectRepository = createPostgresProjectRepository(dbClient.db);
    domainRepository = createPostgresDomainRepository(dbClient.db);
    sitemapRepository = createPostgresSitemapRepository(dbClient.db);
    discoveredUrlRepository = createPostgresDiscoveredUrlRepository(dbClient.db);
    checkDatabaseReady = options?.checkDatabaseReady ?? createDbReadinessCheck(dbClient);
    auth = options?.auth ?? createAuth(dbClient.db);
  }

  const projectService = createProjectService(projectRepository);
  const domainService = createDomainService(domainRepository);
  const authDb = dbClient?.db ?? null;
  const invitationService = authDb ? createInvitationService(authDb, metrics) : null;

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
          'req.headers["set-cookie"]',
          'res.headers["set-cookie"]',
          'req.headers["proxy-authorization"]',
          'req.body.password',
          'req.body.token',
          'req.body.newPassword',
          'req.body.currentPassword',
          '*.password',
          '*.token',
          '*.tokenHash',
          '*.sessionToken',
          '*.apiKey',
          '*.secret',
          '*.betterAuthSecret',
          '*.verificationToken',
        ],
        censor: '[redacted]',
      },
    },
    bodyLimit: 32 * 1024,
    // Only trusts X-Forwarded-* when TRUSTED_PROXY_CIDRS names a specific
    // internal gateway (see docker/gateway/nginx-tls.conf +
    // compose.hardened-ci.yml) — never a blanket true/wildcard, so an
    // arbitrary caller can't spoof its own forwarded headers.
    trustProxy: env.TRUSTED_PROXY_CIDRS.length > 0 ? env.TRUSTED_PROXY_CIDRS : false,
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
  // Render API key requests (server-to-server, no cookies) don't need CORS
  // at all; browser management requests need exact-origin, credentialed
  // CORS restricted to the configured trusted origins allowlist. Origin
  // comparison uses the same parsed-protocol+host normalization as
  // src/lib/csrf.ts (never a raw string / prefix / substring check), so
  // https://EXAMPLE.com and https://example.com:443 are recognized as the
  // same trusted https://example.com entry, while sibling subdomains and
  // prefix/suffix-confusable hostnames are not.
  const trustedOrigins = new Set(env.AUTH_TRUSTED_ORIGINS);
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) {
        // No Origin header: server-to-server / same-origin / curl. Allowed
        // through CORS (not credentialed browser cross-site traffic); the
        // render endpoint doesn't use cookies, and management endpoints are
        // additionally protected by the Origin check in the CSRF module.
        cb(null, true);
        return;
      }
      const normalized = normalizeOriginForComparison(origin);
      cb(null, !!normalized && trustedOrigins.has(normalized));
    },
    credentials: true,
    // Minimum method/header allowlist actually used by the cookie-authenticated
    // management API — an arbitrary Access-Control-Request-Headers value
    // is never reflected back (the plugin's default behavior without an
    // explicit allowedHeaders list), and x-render-api-key is deliberately
    // excluded so the render endpoint does not become browser-callable
    // cross-origin through permissive CORS (it is never cookie-authenticated
    // and has no browser use case).
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type'],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    max: 30,
    timeWindow: '1 minute',
  });

  if (auth) {
    await registerAuthRoutes(app, auth, metrics);
  }

  if (auth && authDb && invitationService) {
    await app.register(organizationRoutes, {
      prefix: '/v1',
      auth,
      db: authDb,
      invitationService,
      metrics,
      proxyUrl: env.OUTBOUND_PROXY_URL,
      trustedOrigins,
    });
    await app.register(onboardingRoutes, { prefix: '/v1', auth, invitationService });
  }

  await app.register(healthRoutes, {
    isReady: async () =>
      !capacity.getSnapshot().closed &&
      !shuttingDown &&
      (!env.REQUIRE_OUTBOUND_PROXY || !!env.OUTBOUND_PROXY_URL) &&
      (await checkDatabaseReady()),
  });
  await app.register(metricsRoutes, { metrics });

  // Fake-repo test default: denies every key (no valid scope can ever be
  // constructed without a real Postgres-backed apikey/organization/project
  // row) — tests that specifically exercise a successful render inject
  // options.renderApiKeyVerifier/renderTenant instead.
  const denyAllVerifier: ApiKeyVerifier = {
    api: { verifyApiKey: (async () => ({ valid: false, error: { code: 'INVALID_API_KEY' }, key: null })) as ApiKeyVerifier['api']['verifyApiKey'] },
  };
  const denyAllTenant: NonNullable<AppOptions['renderTenant']> = {
    getOrganizationStatus: async () => null,
    getProjectForOrganization: async () => null,
    getDomainForOrganizationProject: async () => null,
  };

  const renderApiKeyVerifier: ApiKeyVerifier = authDb ? auth! : (options?.renderApiKeyVerifier ?? denyAllVerifier);
  const renderTenant = authDb ? createTenantRepository(authDb) : (options?.renderTenant ?? denyAllTenant);
  // Only constructed on the real-Postgres path — render.ts treats this as
  // optional and skips audit entirely when absent (fake-repo unit tests).
  const renderAuditService = authDb ? createAuditService(createPostgresAuditRepository(authDb, metrics)) : undefined;

  await app.register(renderRoutes, {
    prefix: '/v1',
    renderUrl: service.renderUrl,
    auth: renderApiKeyVerifier,
    tenant: renderTenant,
    metrics,
    auditService: renderAuditService,
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
