import type { FastifyBaseLogger } from 'fastify';
import type { Metrics } from './metrics.js';

// Platform-level security events (distinct from the tenant audit log in
// src/repositories/audit-repository.ts): auth.* events have no
// organizationId at the time they happen — a login attempt precedes
// knowing which organization(s) the user belongs to — so they are never
// written to audit_events. Structured logs + metrics only, best-effort
// (never blocks the auth flow, never rolls back anything). See
// AUDIT_LOGGING.md for the tenant-audit-vs-platform-security-event split.
export type AuthSecurityEvent = 'auth.login.success' | 'auth.login.failure' | 'auth.logout';

export interface RecordAuthSecurityEventInput {
  event: AuthSecurityEvent;
  requestId: string;
  errorCode?: string;
}

export function recordAuthSecurityEvent(
  logger: FastifyBaseLogger,
  metrics: Metrics,
  input: RecordAuthSecurityEventInput,
): void {
  // Never log email, password, session token, or IP here — this is a
  // stable-shape event log, not a debugging dump. request-level logging
  // (with its own redact list) already covers the raw request if needed.
  logger.info(
    { event: input.event, requestId: input.requestId, errorCode: input.errorCode },
    'auth security event',
  );
  try {
    metrics.incrementAuthSecurityEvent(input.event);
  } catch {
    // Metrics failures must never affect the auth flow.
  }
}
