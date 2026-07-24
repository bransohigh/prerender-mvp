import type { FastifyBaseLogger } from 'fastify';
import type { CacheIntegrityFailureReasonLabel, Metrics } from './metrics.js';

// Structured logging event names for the HTML cache object layer
// (Phase 8A-2) — distinct from the src/repositories/postgres/cache-repository.ts
// metadata layer. Same allowlist discipline as src/lib/security-events.ts:
// stable-shape fields only, never the HTML body, normalized/raw URL,
// query string, full storage key, filesystem path, provider credentials,
// API key, cookie, request header, or request body.
export type CacheObjectEvent =
  | 'cache.object.write.success'
  | 'cache.object.write.failure'
  | 'cache.object.read.success'
  | 'cache.object.read.failure'
  | 'cache.object.integrity_failure'
  | 'cache.object.cleanup.failure'
  | 'cache.metadata.ready'
  | 'cache.metadata.failed';

export interface RecordCacheObjectEventInput {
  event: CacheObjectEvent;
  operation?: string;
  result?: 'success' | 'failure';
  errorCode?: string;
  contentEncoding?: string;
  contentBytes?: number;
  // First few hex characters only — never the full hash, and never
  // enough to be a practical dictionary/rainbow lookup key back to the
  // normalized URL.
  cacheKeyHashPrefix?: string;
  generation?: number;
  organizationId?: string;
  projectId?: string;
  domainId?: string;
}

// Success paths are deliberately NOT logged at all by default (per the
// "avoid noisy success logs" instruction) except at debug level — callers
// pass level explicitly only for failure/integrity events, which is where
// operational signal actually matters.
export function recordCacheObjectEvent(logger: FastifyBaseLogger, input: RecordCacheObjectEventInput): void {
  const fields = {
    event: input.event,
    operation: input.operation,
    result: input.result,
    errorCode: input.errorCode,
    contentEncoding: input.contentEncoding,
    contentBytes: input.contentBytes,
    cacheKeyHashPrefix: input.cacheKeyHashPrefix,
    generation: input.generation,
    organizationId: input.organizationId,
    projectId: input.projectId,
    domainId: input.domainId,
  };
  if (input.result === 'failure' || input.event === 'cache.object.integrity_failure' || input.event === 'cache.object.cleanup.failure') {
    logger.warn(fields, 'cache object event');
  } else {
    logger.debug(fields, 'cache object event');
  }
}

export function recordCacheIntegrityFailureMetric(metrics: Metrics, reason: CacheIntegrityFailureReasonLabel): void {
  try {
    metrics.incrementCacheIntegrityFailure(reason);
  } catch {
    // Metrics failures must never affect the read/write flow.
  }
}
