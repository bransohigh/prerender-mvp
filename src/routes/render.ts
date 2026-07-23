import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { isCapacityError } from '../lib/errors.js';
import { safeUrlOrigin } from '../lib/url-security.js';
import { normalizeTargetUrl, InvalidTargetUrlError } from '../lib/url-normalize.js';
import { createNoopMetrics, safeMetricsCall, type Metrics, type RenderResultLabel } from '../lib/metrics.js';
import { createRateLimiter, type RateLimiter } from '../lib/rate-limiter.js';
import { AppError, isAppError, type AppErrorCode } from '../lib/app-error.js';
import { verifyRenderApiKey, type ApiKeyVerifier, type TrustedRenderKeyScope } from '../services/render-api-key-auth-service.js';
import type { TenantRepository } from '../repositories/postgres/tenant-repository.js';
import type { RenderFn } from '../types/render.js';
import type { AuditService } from '../services/audit-service.js';

// Only these AppErrorCodes are ever audited as render.authorization_rejected
// — every one of them is thrown AFTER verifyRenderApiKey has already
// succeeded (see the `scope` variable below), meaning the key was
// cryptographically valid, unexpired, and unrevoked at verification time,
// and organizationId/projectId came from that verified key's own
// metadata — so attributing the rejection to that key's scope reveals
// nothing an attacker didn't already control (their own key). A garbage,
// unknown, expired, revoked, or malformed-metadata key never reaches this
// set — those stay platform security logs/metrics only (no trusted scope
// exists to attribute them to).
const AUDITABLE_REJECTION_CODES = new Set<AppErrorCode>([
  'ORGANIZATION_NOT_FOUND',
  'ORGANIZATION_SUSPENDED',
  'PROJECT_NOT_FOUND',
  'PROJECT_SUSPENDED',
  'DOMAIN_NOT_FOUND',
  'DOMAIN_NOT_VERIFIED',
  'URL_DOMAIN_MISMATCH',
]);

const renderBodySchema = z.object({
  domainId: z.string().uuid(),
  url: z.string().url().max(2048),
});

const RENDER_KEY_HEADER = 'x-render-api-key';
const MAX_RENDER_KEY_HEADER_LENGTH = 512;
const RENDER_KEY_PREFIX = 'pr_live_';

export interface RenderRouteOptions {
  renderUrl: RenderFn;
  auth: ApiKeyVerifier;
  tenant: Pick<TenantRepository, 'getOrganizationStatus' | 'getProjectForOrganization' | 'getDomainForOrganizationProject'>;
  metrics?: Metrics;
  // Optional: absent in fake-repo unit tests. When present, a safely
  // attributable rejection (see AUDITABLE_REJECTION_CODES) writes a
  // best-effort render.authorization_rejected row — a failure here is
  // swallowed and never changes the render decision itself (a render is
  // never allowed, and a rejection is never turned into a 500, because
  // the audit write failed).
  auditService?: AuditService;
  getCapacitySnapshot?: () => { activeRenders: number; queuedRenders: number };
  invalidKeyRateLimiter?: RateLimiter;
  validKeyRateLimiter?: RateLimiter;
}

// Maps our internal AppErrorCode to the externally-consistent HTTP
// response. Invalid/expired/revoked/malformed-metadata keys all get the
// same generic 401 message — internal error codes distinguish the cause
// for logging/metrics, but the response body never lets a caller
// enumerate key state (whether a presented value is a real-but-expired
// key vs. pure garbage).
function renderErrorResponse(code: AppErrorCode): { status: number; body: { error: string; message: string } } {
  switch (code) {
    case 'API_KEY_INVALID':
    case 'API_KEY_EXPIRED':
    case 'API_KEY_REVOKED':
    case 'API_KEY_METADATA_INVALID':
      return { status: 401, body: { error: 'API_KEY_INVALID', message: 'Invalid API key' } };
    case 'RATE_LIMITED':
      return { status: 429, body: { error: 'RATE_LIMITED', message: 'Too many requests' } };
    case 'ORGANIZATION_SUSPENDED':
    case 'PROJECT_SUSPENDED':
      return { status: 403, body: { error: code, message: 'Forbidden' } };
    case 'ORGANIZATION_NOT_FOUND':
    case 'PROJECT_NOT_FOUND':
    case 'DOMAIN_NOT_FOUND':
      // Never reveals which of key/org/project/domain was the reason —
      // same 404 shape for "doesn't exist" and "not in this key's scope".
      return { status: 404, body: { error: 'DOMAIN_NOT_FOUND', message: 'Not found' } };
    case 'DOMAIN_NOT_VERIFIED':
      return { status: 409, body: { error: 'DOMAIN_NOT_VERIFIED', message: 'Domain not verified' } };
    case 'URL_DOMAIN_MISMATCH':
    case 'INVALID_RENDER_URL':
      return { status: 400, body: { error: code, message: 'Invalid render URL' } };
    default:
      return { status: 400, body: { error: 'bad_request', message: 'Bad request' } };
  }
}

function metricsLabelForCode(code: AppErrorCode): RenderResultLabel {
  switch (code) {
    case 'API_KEY_INVALID':
      return 'invalid_key';
    case 'API_KEY_EXPIRED':
      return 'expired_key';
    case 'API_KEY_REVOKED':
      return 'revoked_key';
    case 'API_KEY_METADATA_INVALID':
      return 'malformed_metadata';
    case 'RATE_LIMITED':
      return 'rate_limited';
    case 'ORGANIZATION_SUSPENDED':
      return 'organization_suspended';
    case 'PROJECT_SUSPENDED':
      return 'project_suspended';
    case 'DOMAIN_NOT_VERIFIED':
      return 'domain_not_verified';
    case 'URL_DOMAIN_MISMATCH':
      return 'domain_mismatch';
    default:
      return 'validation_error';
  }
}

export const renderRoutes: FastifyPluginAsync<RenderRouteOptions> = async (app, opts) => {
  const { renderUrl, auth, tenant } = opts;
  const metrics = opts.metrics ?? createNoopMetrics();
  const getCapacitySnapshot = opts.getCapacitySnapshot ?? (() => ({ activeRenders: 0, queuedRenders: 0 }));
  const invalidKeyRateLimiter =
    opts.invalidKeyRateLimiter ??
    createRateLimiter({ windowMs: env.RENDER_KEY_INVALID_RATE_LIMIT_WINDOW_MS, maxAttempts: env.RENDER_KEY_INVALID_RATE_LIMIT_MAX });
  const validKeyRateLimiter =
    opts.validKeyRateLimiter ??
    createRateLimiter({ windowMs: env.RENDER_KEY_VALID_RATE_LIMIT_WINDOW_MS, maxAttempts: env.RENDER_KEY_VALID_RATE_LIMIT_MAX });

  app.addHook('onClose', () => {
    if (!opts.invalidKeyRateLimiter) invalidKeyRateLimiter.shutdown();
    if (!opts.validKeyRateLimiter) validKeyRateLimiter.shutdown();
  });

  app.post('/render', async (request, reply) => {
    const startedAt = Date.now();
    // Set only after verifyRenderApiKey succeeds (see below) — reject()
    // uses its presence to decide whether a rejection is safely
    // attributable to a real, verified key scope.
    let scope: TrustedRenderKeyScope | undefined;

    async function reject(code: AppErrorCode) {
      const { status, body } = renderErrorResponse(code);
      const label = metricsLabelForCode(code);
      safeMetricsCall(() => metrics.incrementRenderResult(label));
      request.log.info({ event: 'render_rejected', result: label }, 'Render reddedildi');

      if (scope && AUDITABLE_REJECTION_CODES.has(code) && opts.auditService) {
        // Best-effort: never throws past this point, never delays the
        // rejection response beyond a normal DB round trip, and never
        // turns a rejection into anything other than the rejection
        // already decided above — an audit failure cannot "allow" a
        // render, since renderUrl() is never reached from this function.
        try {
          await opts.auditService.record({
            organizationId: scope.organizationId,
            actor: { type: 'api_key', apiKeyId: scope.apiKeyId },
            action: 'render.authorization_rejected',
            targetType: 'domain',
            targetId: null,
            result: 'failure',
            errorCode: code,
            requestId: request.id,
            metadata: { reasonCode: code },
          });
        } catch (auditErr) {
          request.log.error({ event: 'audit.write.failure', action: 'render.authorization_rejected' }, 'audit write failed');
          void auditErr;
        }
      }

      if (status === 429) {
        // Retry-After set by the caller before invoking reject() for the
        // rate-limit path specifically (needs the computed seconds value).
        return reply.code(status).send({ ...body, requestId: request.id });
      }
      return reply.code(status).send({ ...body, requestId: request.id });
    }

    // 1. Header presence / duplicate-header / basic format validation —
    // before any DB or Better Auth work.
    const headerValue = request.headers[RENDER_KEY_HEADER];
    if (Array.isArray(headerValue)) {
      return reject('API_KEY_INVALID'); // duplicate header
    }
    if (typeof headerValue !== 'string' || headerValue.length === 0) {
      return reject('API_KEY_INVALID');
    }
    if (headerValue.length > MAX_RENDER_KEY_HEADER_LENGTH || !headerValue.startsWith(RENDER_KEY_PREFIX)) {
      return reject('API_KEY_INVALID');
    }
    // Legacy/alternate render-auth mechanisms are never accepted, even if
    // supplied alongside a well-formed x-render-api-key.
    if (request.headers['x-api-key'] !== undefined) {
      return reject('API_KEY_INVALID');
    }
    const body = request.body as Record<string, unknown> | undefined;
    if (body && ('apiKey' in body || 'key' in body || 'x-render-api-key' in body)) {
      return reject('API_KEY_INVALID');
    }
    if (typeof (request.query as Record<string, unknown> | undefined)?.['apiKey'] !== 'undefined') {
      return reject('API_KEY_INVALID');
    }

    // 2. Invalid-attempt rate-limit precheck, keyed by source IP — never
    // by the raw key. Checked before Better Auth verification so repeated
    // garbage keys don't drive repeated DB lookups.
    const ipDecision = invalidKeyRateLimiter.check(request.ip);
    if (!ipDecision.allowed) {
      safeMetricsCall(() => metrics.incrementRenderResult('rate_limited'));
      request.log.info({ event: 'render_rejected', result: 'rate_limited' }, 'Render reddedildi');
      return reply
        .code(429)
        .header('Retry-After', String(ipDecision.retryAfterSeconds))
        .send({ error: 'RATE_LIMITED', message: 'Too many requests', requestId: request.id });
    }

    // 3-4-5. Better Auth key verification + fail-closed metadata + current
    // API-key state (all inside verifyRenderApiKey).
    try {
      scope = await verifyRenderApiKey(auth, headerValue);
    } catch (err) {
      if (isAppError(err)) return reject(err.code);
      throw err;
    }
    // A garbage/unknown key already consumed one invalid-attempt slot
    // above; a real-but-invalid-state key (expired/revoked) also counts
    // against the IP limiter — intentional, since both are failed
    // attempts from that source.

    try {
      // 6. Organization lookup + active-state check.
      const orgStatus = await tenant.getOrganizationStatus(scope.organizationId);
      if (!orgStatus) throw new AppError('ORGANIZATION_NOT_FOUND', 'Organization not found');
      if (orgStatus === 'suspended') throw new AppError('ORGANIZATION_SUSPENDED', 'Organization suspended');

      // 7-8. Project lookup scoped to organization AND key projectId; active-state check.
      const project = await tenant.getProjectForOrganization(scope.organizationId, scope.projectId);
      if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
      if (project.status === 'suspended') throw new AppError('PROJECT_SUSPENDED', 'Project suspended');

      // 9. Domain lookup scoped to organization AND project (never a bare
      // domainId lookup) — a key for project A can never resolve a domain
      // belonging to project B, even in the same organization.
      const parsedBody = renderBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reject('INVALID_RENDER_URL');
      }
      const domain = await tenant.getDomainForOrganizationProject(scope.organizationId, scope.projectId, parsedBody.data.domainId);
      if (!domain) throw new AppError('DOMAIN_NOT_FOUND', 'Domain not found');

      // 10. Domain verified-state check.
      if (domain.status !== 'verified') throw new AppError('DOMAIN_NOT_VERIFIED', 'Domain not verified');

      // 11-12. URL normalization + exact hostname match (no implicit
      // subdomain authorization — normalizeTargetUrl requires an exact
      // hostname match against domain.normalizedHostname).
      let normalized;
      try {
        normalized = normalizeTargetUrl(parsedBody.data.url, domain.normalizedHostname);
      } catch (err) {
        const code = err instanceof InvalidTargetUrlError && err.reason === 'host_mismatch' ? 'URL_DOMAIN_MISMATCH' : 'INVALID_RENDER_URL';
        throw new AppError(code, 'Invalid render URL');
      }

      // 13. Existing public URL/SSRF validation happens inside renderUrl()
      // itself (safeFetch/urlValidator) — unchanged from before this
      // checkpoint.
      const safeOrigin = safeUrlOrigin(normalized.normalizedUrl);

      // 14. Valid-key rate limit, keyed by apiKeyId (never plaintext key
      // material) — checked last, right before capacity acquisition, so a
      // key that fails any authorization check above never consumes a
      // valid-key rate-limit slot for a request that was going to be
      // rejected anyway.
      const keyDecision = validKeyRateLimiter.check(scope.apiKeyId);
      if (!keyDecision.allowed) {
        safeMetricsCall(() => metrics.incrementRenderResult('rate_limited'));
        request.log.info({ event: 'render_rejected', result: 'rate_limited' }, 'Render reddedildi');
        return reply
          .code(429)
          .header('Retry-After', String(keyDecision.retryAfterSeconds))
          .send({ error: 'RATE_LIMITED', message: 'Too many requests', requestId: request.id });
      }

      // 15-16. Capacity acquisition + Chromium render — the only point
      // past which a capacity slot may be taken; every rejection above
      // returns before this line.
      try {
        const result = await renderUrl(normalized.normalizedUrl);
        const durationMs = Date.now() - startedAt;
        const queueWaitMs = Math.max(0, durationMs - result.renderTimeMs);
        safeMetricsCall(() => metrics.incrementRenderResult('success'));
        request.log.info(
          {
            event: 'render_completed',
            result: 'success',
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            domainId: domain.id,
            renderTimeMs: result.renderTimeMs,
            queueWaitMs,
            totalTimeMs: durationMs,
            statusCode: result.statusCode,
            finalUrlOrigin: safeUrlOrigin(result.finalUrl),
            ...getCapacitySnapshot(),
          },
          'Render tamamlandı',
        );
        return result;
      } catch (error) {
        if (isCapacityError(error)) {
          const resultLabel: RenderResultLabel =
            error.code === 'RENDER_QUEUE_FULL' ? 'queue_full' : error.code === 'RENDER_QUEUE_TIMEOUT' ? 'queue_timeout' : 'capacity_closed';
          safeMetricsCall(() => metrics.incrementRenderResult(resultLabel));
          request.log.warn(
            { event: 'render_rejected', result: resultLabel, errorCode: error.code, requestUrlOrigin: safeOrigin, ...getCapacitySnapshot() },
            'Render kapasite hatası',
          );
          return reply
            .code(503)
            .header('Retry-After', '5')
            .send({ error: 'service_unavailable', code: error.code, message: error.message, requestId: request.id });
        }

        safeMetricsCall(() => metrics.incrementRenderResult('render_error'));
        request.log.error(
          { event: 'render_failed', result: 'render_error', requestUrlOrigin: safeOrigin, error, ...getCapacitySnapshot() },
          'Render işlemi başarısız',
        );
        const message = error instanceof Error ? error.message : 'Bilinmeyen hata';
        return reply.code(422).send({ error: message, requestId: request.id });
      }
    } catch (err) {
      if (isAppError(err)) return reject(err.code);
      throw err;
    }
  });
};
