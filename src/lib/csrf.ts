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
export function createOriginCheckHook(trustedOrigins: ReadonlySet<string>) {
  return async function checkOrigin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!MUTATING_METHODS.has(request.method)) {
      return;
    }
    const origin = request.headers['origin'];
    if (typeof origin !== 'string' || origin.length === 0) {
      // Browser mutation requests always send Origin; a missing Origin on
      // a mutating cookie-authenticated request is treated as untrusted
      // rather than assumed to be a legitimate server-to-server call.
      throw new AppError('FORBIDDEN', 'Missing Origin header');
    }
    if (!trustedOrigins.has(origin)) {
      throw new AppError('FORBIDDEN', 'Untrusted Origin');
    }
    void reply;
  };
}
