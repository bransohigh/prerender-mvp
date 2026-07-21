import type { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from './app-error.js';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// Minimum CSRF protection for cookie-authenticated management routes
// (Milestone 2 scope — the full adversarial matrix, preflight/credentials
// tests, and server-to-server exemptions are Milestone 3). CORS alone
// (src/app.ts's trusted-origin allowlist) is not treated as sufficient:
// this hook independently checks the Origin header on every mutating
// request to an organization-scoped route, since CORS only blocks the
// browser from *reading* a cross-origin response, not from *sending* the
// request in the first place — the classic CSRF gap.
//
// The render API-key endpoint (POST /v1/render) is never cookie-authenticated
// and must not be registered with this hook — see src/app.ts, where it's
// only applied to the organizationRoutes plugin scope.
// Origin must be an exact scheme+host(+port) match against the configured
// allowlist — no path/query/fragment, matching the same strict shape
// enforced at parse time by src/lib/trusted-origins.ts. A malformed Origin
// (one that doesn't even parse, or that carries a path/query/fragment) is
// rejected the same way as an untrusted one.
function isWellFormedOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') return false;
  if (parsed.search || parsed.hash) return false;
  if (parsed.username || parsed.password) return false;
  return true;
}

export function createOriginCheckHook(trustedOrigins: ReadonlySet<string>) {
  return async function checkOrigin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!MUTATING_METHODS.has(request.method)) {
      return;
    }
    const origin = request.headers['origin'];
    // Deliberately the same generic message/code for every rejection
    // reason (missing, malformed, untrusted) — the response never reveals
    // which trusted origins are configured. Sent directly (not thrown) so
    // it doesn't depend on each route handler's own try/catch — a
    // preHandler hook's thrown error would otherwise hit Fastify's default
    // error formatter instead of the AppError JSON shape.
    if (typeof origin !== 'string' || origin.length === 0 || !isWellFormedOrigin(origin) || !trustedOrigins.has(origin)) {
      const err = new AppError('CSRF_ORIGIN_REJECTED', 'Origin check failed');
      await reply.code(err.statusCode).send({ error: err.code, message: err.message, requestId: request.id });
    }
  };
}
