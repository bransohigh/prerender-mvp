import type { FastifyBaseLogger } from 'fastify';
import { computeCacheKey, type CacheIdentity } from '../lib/cache-identity.js';
import {
  assertCacheObjectKeyMatches,
  buildCacheObjectKey,
  InvalidCacheStorageKeyInputError,
  parseCacheObjectKey,
  type CacheContentEncoding,
} from '../lib/cache-storage-key.js';
import { computeHtmlContentHash, contentHashesMatch, isValidContentHash } from '../lib/html-content-hash.js';
import { compressHtml, decompressHtml, CorruptCompressedDataError, DecompressedSizeLimitExceededError, UnsupportedEncodingError } from '../lib/html-compression.js';
import { DEFAULT_CACHE_OBJECT_LIMITS, type CacheObjectLimits } from '../lib/cache-object-limits.js';
import { computeFreshnessWindow, DEFAULT_CACHE_POLICY, type CachePolicy } from '../lib/cache-policy.js';
import { recordCacheObjectEvent, recordCacheIntegrityFailureMetric } from '../lib/cache-object-events.js';
import { createNoopMetrics, type Metrics } from '../lib/metrics.js';
import type { HtmlObjectStore } from '../repositories/html-object-store.js';
import { ObjectStorageError } from '../repositories/html-object-store.js';
import type { CacheEntryRow, CacheRepository } from '../repositories/cache-repository.js';

export class HtmlSizeLimitExceededError extends Error {}
export class StoredObjectSizeLimitExceededError extends Error {}
export class CacheEntryNotReadyError extends Error {}
export class CacheWriteConflictError extends Error {}

// Thrown for anything read.ts calls a "typed safe integrity error" — the
// message is always a fixed, safe string; it never includes the HTML
// body, the normalized URL, the storage key, or a raw provider error.
export class CacheIntegrityError extends Error {
  readonly reason: 'missing_object' | 'corrupt_data' | 'hash_mismatch' | 'size_limit_exceeded' | 'encoding_mismatch' | 'malformed_metadata';
  constructor(reason: CacheIntegrityError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface CacheStorageServiceOptions {
  repository: CacheRepository;
  objectStore: HtmlObjectStore;
  logger: FastifyBaseLogger;
  metrics?: Metrics;
  limits?: CacheObjectLimits;
}

export interface CommitRenderedHtmlInput {
  identity: CacheIdentity;
  html: string;
  responseStatus: number;
  expectedGeneration: number;
  contentEncoding?: CacheContentEncoding;
  policy?: CachePolicy;
  now: Date;
}

export type CommitRenderedHtmlResult =
  | { outcome: 'success'; entry: CacheEntryRow }
  | { outcome: 'conflict' };

export interface MarkRenderFailedInput {
  identity: CacheIdentity;
  expectedGeneration: number;
  lastErrorCode: string;
  now: Date;
}

export interface ReadReadyHtmlInput {
  identity: CacheIdentity;
  now: Date;
}

export interface ReadReadyHtmlResult {
  html: string;
  entry: CacheEntryRow;
}

export interface InvalidateEntryInput {
  identity: CacheIdentity;
  now: Date;
}

function identityScope(identity: CacheIdentity, key: { cacheKeyVersion: number; cacheKeyHash: string }) {
  return {
    organizationId: identity.organizationId,
    projectId: identity.projectId,
    domainId: identity.domainId,
    cacheKeyVersion: key.cacheKeyVersion,
    cacheKeyHash: key.cacheKeyHash,
  };
}

function hashPrefix(hash: string): string {
  return hash.slice(0, 8);
}

// Coordinates cache metadata (src/repositories/cache-repository.ts) and
// HTML object storage (src/repositories/html-object-store.ts) without
// touching /v1/render — see CACHE_ARCHITECTURE.md. Every public method
// takes a full CacheIdentity rather than loose org/project/domain
// strings, so a caller can never accidentally build a scope from
// unrelated fields.
export function createCacheStorageService(options: CacheStorageServiceOptions) {
  const { repository, objectStore, logger } = options;
  const metrics = options.metrics ?? createNoopMetrics();
  const limits = options.limits ?? DEFAULT_CACHE_OBJECT_LIMITS;

  async function timedObjectOp<T>(operation: 'write' | 'read' | 'delete' | 'cleanup', fn: () => Promise<T>): Promise<T> {
    const start = process.hrtime.bigint();
    try {
      const result = await fn();
      metrics.incrementCacheObjectOperation(operation, 'success');
      return result;
    } catch (err) {
      metrics.incrementCacheObjectOperation(operation, 'failure');
      throw err;
    } finally {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      metrics.observeCacheObjectOperationDuration(operation, seconds);
    }
  }

  // Best-effort cleanup of an object that was written but must never
  // become "active" (either the metadata update lost an optimistic-
  // concurrency race, or the caller otherwise aborts before committing
  // metadata). A cleanup failure is logged and counted but never thrown —
  // it can only ever leave an unreferenced orphan object, never cause an
  // active object to be deleted or a caller-visible error to change
  // shape.
  async function bestEffortCleanup(storageKey: string, context: { organizationId: string; projectId: string; domainId: string; cacheKeyHash: string; generation: number }): Promise<void> {
    try {
      await timedObjectOp('cleanup', () => objectStore.deleteObject(storageKey));
    } catch (err) {
      recordCacheObjectEvent(logger, {
        event: 'cache.object.cleanup.failure',
        operation: 'cleanup',
        result: 'failure',
        errorCode: err instanceof ObjectStorageError ? err.code : 'unknown',
        cacheKeyHashPrefix: hashPrefix(context.cacheKeyHash),
        generation: context.generation,
        organizationId: context.organizationId,
        projectId: context.projectId,
        domainId: context.domainId,
      });
    }
  }

  async function commitRenderedHtml(input: CommitRenderedHtmlInput): Promise<CommitRenderedHtmlResult> {
    const key = computeCacheKey(input.identity);
    const scope = identityScope(input.identity, key);
    const encoding = input.contentEncoding ?? 'br';
    const policy = input.policy ?? DEFAULT_CACHE_POLICY;

    const htmlBytes = Buffer.byteLength(input.html, 'utf8');
    if (htmlBytes > limits.maxUncompressedHtmlBytes) {
      throw new HtmlSizeLimitExceededError(`rendered HTML exceeds the maximum uncompressed size of ${limits.maxUncompressedHtmlBytes} bytes`);
    }

    const contentHash = computeHtmlContentHash(input.html);
    const compressed = compressHtml(input.html, encoding);
    if (compressed.byteLength > limits.maxStoredObjectBytes) {
      throw new StoredObjectSizeLimitExceededError(`compressed HTML object exceeds the maximum stored size of ${limits.maxStoredObjectBytes} bytes`);
    }

    // The generation this write will become active AS, if it commits —
    // one past what the caller last observed. The object key is built
    // from this new generation, so a concurrent stale writer (still
    // holding the OLD expectedGeneration) computes a different key and
    // can never address these same bytes.
    const newGeneration = input.expectedGeneration + 1;
    const storageKey = buildCacheObjectKey({
      organizationId: input.identity.organizationId,
      projectId: input.identity.projectId,
      domainId: input.identity.domainId,
      cacheKeyHash: key.cacheKeyHash,
      generation: newGeneration,
      contentHash,
      contentEncoding: encoding,
    });

    try {
      await timedObjectOp('write', () => objectStore.putObject({ storageKey, body: compressed, contentEncoding: encoding }));
    } catch (err) {
      recordCacheObjectEvent(logger, {
        event: 'cache.object.write.failure',
        operation: 'write',
        result: 'failure',
        errorCode: err instanceof ObjectStorageError ? err.code : 'unknown',
        contentEncoding: encoding,
        cacheKeyHashPrefix: hashPrefix(key.cacheKeyHash),
        generation: newGeneration,
        organizationId: input.identity.organizationId,
        projectId: input.identity.projectId,
        domainId: input.identity.domainId,
      });
      // Object write failed: metadata must never become ready, and this
      // must never look like a cache miss to the caller — propagate.
      throw err;
    }
    metrics.observeCacheObjectBytes('write', encoding, compressed.byteLength);
    recordCacheObjectEvent(logger, {
      event: 'cache.object.write.success',
      operation: 'write',
      result: 'success',
      contentEncoding: encoding,
      contentBytes: compressed.byteLength,
      cacheKeyHashPrefix: hashPrefix(key.cacheKeyHash),
      generation: newGeneration,
      organizationId: input.identity.organizationId,
      projectId: input.identity.projectId,
      domainId: input.identity.domainId,
    });

    const { freshUntil, staleUntil } = computeFreshnessWindow(policy, input.now);
    const updated = await repository.updateReadyCacheEntry({
      ...scope,
      storageKey,
      contentHash,
      contentEncoding: encoding,
      contentBytes: compressed.byteLength,
      responseStatus: input.responseStatus,
      renderedAt: input.now,
      freshUntil,
      staleUntil,
      expectedGeneration: input.expectedGeneration,
      now: input.now,
    });

    if (!updated) {
      // Lost the optimistic-concurrency race: some other writer already
      // committed a newer generation. The object we just wrote must never
      // become active — best-effort delete it (an orphan is acceptable if
      // cleanup itself fails; overwriting the active object is not).
      await bestEffortCleanup(storageKey, { ...scope, generation: newGeneration });
      recordCacheObjectEvent(logger, {
        event: 'cache.metadata.failed',
        operation: 'update_ready',
        result: 'failure',
        errorCode: 'generation_conflict',
        cacheKeyHashPrefix: hashPrefix(key.cacheKeyHash),
        generation: newGeneration,
        organizationId: input.identity.organizationId,
        projectId: input.identity.projectId,
        domainId: input.identity.domainId,
      });
      return { outcome: 'conflict' };
    }

    recordCacheObjectEvent(logger, {
      event: 'cache.metadata.ready',
      operation: 'update_ready',
      result: 'success',
      cacheKeyHashPrefix: hashPrefix(key.cacheKeyHash),
      generation: updated.generation,
      organizationId: input.identity.organizationId,
      projectId: input.identity.projectId,
      domainId: input.identity.domainId,
    });
    return { outcome: 'success', entry: updated };
  }

  async function markRenderFailed(input: MarkRenderFailedInput): Promise<CacheEntryRow | null> {
    const key = computeCacheKey(input.identity);
    const scope = identityScope(input.identity, key);
    const updated = await repository.updateFailedCacheEntry({
      ...scope,
      lastErrorCode: input.lastErrorCode,
      expectedGeneration: input.expectedGeneration,
      now: input.now,
    });
    recordCacheObjectEvent(logger, {
      event: 'cache.metadata.failed',
      operation: 'update_failed',
      result: updated ? 'success' : 'failure',
      errorCode: updated ? input.lastErrorCode : 'generation_conflict',
      cacheKeyHashPrefix: hashPrefix(key.cacheKeyHash),
      organizationId: input.identity.organizationId,
      projectId: input.identity.projectId,
      domainId: input.identity.domainId,
    });
    return updated;
  }

  function failIntegrity(reason: CacheIntegrityError['reason'], message: string, context: { organizationId: string; projectId: string; domainId: string; cacheKeyHash: string }): never {
    recordCacheIntegrityFailureMetric(metrics, reason);
    recordCacheObjectEvent(logger, {
      event: 'cache.object.integrity_failure',
      operation: 'read',
      result: 'failure',
      errorCode: reason,
      cacheKeyHashPrefix: hashPrefix(context.cacheKeyHash),
      organizationId: context.organizationId,
      projectId: context.projectId,
      domainId: context.domainId,
    });
    throw new CacheIntegrityError(reason, message);
  }

  async function readReadyHtml(input: ReadReadyHtmlInput): Promise<ReadReadyHtmlResult> {
    const key = computeCacheKey(input.identity);
    const scope = identityScope(input.identity, key);
    const scopeCtx = { organizationId: input.identity.organizationId, projectId: input.identity.projectId, domainId: input.identity.domainId, cacheKeyHash: key.cacheKeyHash };

    const entry = await repository.findCacheEntryByIdentity(scope);
    if (!entry || entry.status !== 'ready') {
      throw new CacheEntryNotReadyError('no ready cache entry for this identity');
    }

    // Metadata consistency, checked BEFORE trusting anything from the row
    // (section 14) — a malformed row must fail closed, never be served.
    if (!entry.storageKey || !entry.contentHash || !entry.contentEncoding || entry.contentBytes == null || !Number.isInteger(entry.generation) || entry.generation < 1) {
      failIntegrity('malformed_metadata', 'cache entry metadata is incomplete', scopeCtx);
    }
    if (!isValidContentHash(entry.contentHash!)) {
      failIntegrity('malformed_metadata', 'cache entry content hash is malformed', scopeCtx);
    }

    let parsedKey;
    try {
      parsedKey = parseCacheObjectKey(entry.storageKey!);
      assertCacheObjectKeyMatches(entry.storageKey!, {
        cacheKeyHash: key.cacheKeyHash,
        generation: entry.generation,
        contentHash: entry.contentHash!,
        contentEncoding: entry.contentEncoding as CacheContentEncoding,
      });
    } catch (err) {
      if (err instanceof InvalidCacheStorageKeyInputError) {
        failIntegrity('malformed_metadata', 'cache entry storage key does not match its own metadata', scopeCtx);
      }
      throw err;
    }
    if (parsedKey.contentEncoding !== entry.contentEncoding) {
      failIntegrity('encoding_mismatch', 'stored object encoding does not match metadata content encoding', scopeCtx);
    }

    let stored;
    try {
      stored = await timedObjectOp('read', () => objectStore.getObject(entry.storageKey!));
    } catch (err) {
      recordCacheObjectEvent(logger, {
        event: 'cache.object.read.failure',
        operation: 'read',
        result: 'failure',
        errorCode: err instanceof ObjectStorageError ? err.code : 'unknown',
        cacheKeyHashPrefix: hashPrefix(key.cacheKeyHash),
        generation: entry.generation,
        organizationId: input.identity.organizationId,
        projectId: input.identity.projectId,
        domainId: input.identity.domainId,
      });
      throw err;
    }
    if (!stored) {
      failIntegrity('missing_object', 'referenced cache object is missing from storage', scopeCtx);
    }
    if (stored.body.byteLength > limits.maxStoredObjectBytes) {
      failIntegrity('size_limit_exceeded', 'stored cache object exceeds the maximum allowed size', scopeCtx);
    }

    let html: string;
    try {
      html = decompressHtml(stored.body, entry.contentEncoding as CacheContentEncoding, limits.maxDecompressedReadBytes);
    } catch (err) {
      if (err instanceof DecompressedSizeLimitExceededError) {
        failIntegrity('size_limit_exceeded', 'decompressed cache object exceeds the maximum allowed size', scopeCtx);
      }
      if (err instanceof CorruptCompressedDataError || err instanceof UnsupportedEncodingError) {
        failIntegrity('corrupt_data', 'stored cache object could not be decompressed', scopeCtx);
      }
      throw err;
    }

    const recomputedHash = computeHtmlContentHash(html);
    if (!contentHashesMatch(recomputedHash, entry.contentHash!)) {
      failIntegrity('hash_mismatch', 'decompressed cache object content hash does not match stored metadata', scopeCtx);
    }

    metrics.observeCacheObjectBytes('read', entry.contentEncoding as CacheContentEncoding, stored.body.byteLength);
    recordCacheObjectEvent(logger, {
      event: 'cache.object.read.success',
      operation: 'read',
      result: 'success',
      contentEncoding: entry.contentEncoding,
      contentBytes: stored.body.byteLength,
      cacheKeyHashPrefix: hashPrefix(key.cacheKeyHash),
      generation: entry.generation,
      organizationId: input.identity.organizationId,
      projectId: input.identity.projectId,
      domainId: input.identity.domainId,
    });

    return { html, entry };
  }

  async function invalidateEntry(input: InvalidateEntryInput): Promise<CacheEntryRow | null> {
    const key = computeCacheKey(input.identity);
    const scope = identityScope(input.identity, key);
    // Metadata-only: the previously-referenced object is intentionally
    // NOT deleted here (section 15) — a concurrent reader may still be
    // mid-read against it. Garbage collection of unreferenced objects is
    // a future checkpoint's responsibility.
    return repository.invalidateCacheEntry({ ...scope, now: input.now });
  }

  // Internal-only cleanup hook for tests and a future GC job — never
  // exposed via an HTTP route in this checkpoint.
  async function deleteObjectForTesting(storageKey: string): Promise<void> {
    await objectStore.deleteObject(storageKey);
  }

  return { commitRenderedHtml, markRenderFailed, readReadyHtml, invalidateEntry, deleteObjectForTesting };
}

export type CacheStorageService = ReturnType<typeof createCacheStorageService>;
