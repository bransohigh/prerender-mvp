import type { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from './app-error.js';
import { createNoopMetrics, type Metrics } from './metrics.js';

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
//
// Comparison is by PARSED protocol+host equality against the allowlist
// Set, never by prefix/suffix/substring/includes — a naive string check
// (e.g. origin.startsWith(trusted) or trusted.includes(origin)) would let
// https://example.com.attacker.test or https://attacker-example.com
// through against a https://example.com allowlist entry. WHATWG URL
// parsing lowercases the hostname and (via `.host`) omits the port when
// it's the default for the scheme, so this also safely normalizes
// https://EXAMPLE.com and https://example.com:443 to the same allowlist
// entry as https://example.com — matching exactly how
// src/lib/trusted-origins.ts normalizes the configured allowlist itself,
// so both sides of the comparison use the same normalization.
export function normalizeOriginForComparison(origin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return `${parsed.protocol}//${parsed.host}`;
}

export function createOriginCheckHook(trustedOrigins: ReadonlySet<string>, metrics: Metrics = createNoopMetrics()) {
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
    // error formatter instead of the AppError JSON shape. The metrics
    // label (missing/malformed/untrusted) is more specific than the HTTP
    // response for internal observability only — it is never included in
    // the response body, and never carries the raw Origin value itself.
    if (typeof origin !== 'string' || origin.length === 0) {
      safeIncrementCsrfRejection(metrics, 'missing_origin');
      return sendRejection(reply, request.id);
    }
    const normalized = normalizeOriginForComparison(origin);
    if (!normalized) {
      safeIncrementCsrfRejection(metrics, 'malformed_origin');
      return sendRejection(reply, request.id);
    }
    if (!trustedOrigins.has(normalized)) {
      safeIncrementCsrfRejection(metrics, 'untrusted_origin');
      return sendRejection(reply, request.id);
    }
  };
}

function safeIncrementCsrfRejection(metrics: Metrics, reason: 'missing_origin' | 'malformed_origin' | 'untrusted_origin'): void {
  try {
    metrics.incrementCsrfRejection(reason);
  } catch {
    // A metrics-client error must never affect the rejection response.
  }
}

async function sendRejection(reply: FastifyReply, requestId: string): Promise<void> {
  const err = new AppError('CSRF_ORIGIN_REJECTED', 'Origin check failed');
  await reply.code(err.statusCode).send({ error: err.code, message: err.message, requestId });
}
