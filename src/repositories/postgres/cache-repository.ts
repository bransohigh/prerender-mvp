import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { cacheEntries } from '../../db/schema.js';
import { createNoopMetrics, type Metrics } from '../../lib/metrics.js';
import type {
  CacheRepository,
  CacheEntryRow,
  CacheEntryIdentityScope,
  CreatePendingCacheEntryInput,
  UpdateReadyCacheEntryInput,
  UpdateFailedCacheEntryInput,
  InvalidateCacheEntryInput,
} from '../cache-repository.js';

const UNIQUE_VIOLATION = '23505';

// Same sanitization approach as src/repositories/postgres/tenant-repository.ts
// — never let a raw driver error (which could echo back bound parameter
// values, including the normalized URL) escape to a caller or log line.
function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const direct = (err as { code?: string }).code;
  if (direct) return direct;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    return (cause as { code?: string }).code;
  }
  return undefined;
}

function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === UNIQUE_VIOLATION;
}

function sanitizedError(operation: string, err: unknown): Error {
  if (err instanceof Error) {
    // Strip driver-provided detail (which can include bound values) down
    // to just the class name — callers/logs never see query parameters.
    return new Error(`cache repository ${operation} failed: ${err.constructor.name}`);
  }
  return new Error(`cache repository ${operation} failed`);
}

function toRow(row: typeof cacheEntries.$inferSelect): CacheEntryRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    domainId: row.domainId,
    cacheKeyVersion: row.cacheKeyVersion,
    cacheKeyHash: row.cacheKeyHash,
    normalizedUrl: row.normalizedUrl,
    normalizedUrlHash: row.normalizedUrlHash,
    renderProfileHash: row.renderProfileHash,
    status: row.status,
    storageKey: row.storageKey,
    contentHash: row.contentHash,
    contentEncoding: row.contentEncoding,
    contentBytes: row.contentBytes,
    responseStatus: row.responseStatus,
    renderedAt: row.renderedAt,
    freshUntil: row.freshUntil,
    staleUntil: row.staleUntil,
    lastAttemptAt: row.lastAttemptAt,
    lastErrorCode: row.lastErrorCode,
    invalidatedAt: row.invalidatedAt,
    generation: row.generation,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function identityWhere(scope: CacheEntryIdentityScope) {
  return and(
    eq(cacheEntries.organizationId, scope.organizationId),
    eq(cacheEntries.projectId, scope.projectId),
    eq(cacheEntries.domainId, scope.domainId),
    eq(cacheEntries.cacheKeyVersion, scope.cacheKeyVersion),
    eq(cacheEntries.cacheKeyHash, scope.cacheKeyHash),
  );
}

// Storage-provider-independent metadata repository — see
// src/repositories/cache-repository.ts for the interface contract this
// implements, and CACHE_ARCHITECTURE.md for the surrounding design. Not
// wired into src/routes/render.ts yet.
export function createPostgresCacheRepository(db: Database, metrics: Metrics = createNoopMetrics()): CacheRepository {
  async function timed<T>(operation: Parameters<Metrics['incrementCacheOperation']>[0], fn: () => Promise<T>): Promise<T> {
    const start = process.hrtime.bigint();
    try {
      const result = await fn();
      metrics.incrementCacheOperation(operation, 'success');
      return result;
    } catch (err) {
      metrics.incrementCacheOperation(operation, 'failure');
      throw err;
    } finally {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      metrics.observeCacheRepositoryDuration(operation, seconds);
    }
  }

  async function findCacheEntryByIdentity(scope: CacheEntryIdentityScope): Promise<CacheEntryRow | null> {
    return timed('find_by_identity', async () => {
      const rows = await db.select().from(cacheEntries).where(identityWhere(scope)).limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    });
  }

  // Single INSERT ... ON CONFLICT DO NOTHING is atomic — there is no
  // window between "check if it exists" and "insert" for two concurrent
  // renders of the same identity to both succeed and violate the unique
  // index. If the conflict branch fires, a second SELECT returns the
  // row that's already there (a plain read of committed data, not part
  // of the write's correctness — no race to resolve).
  async function createPendingCacheEntry(input: CreatePendingCacheEntryInput): Promise<CacheEntryRow> {
    return timed('create_pending', async () => {
      try {
        const inserted = await db
          .insert(cacheEntries)
          .values({
            organizationId: input.organizationId,
            projectId: input.projectId,
            domainId: input.domainId,
            cacheKeyVersion: input.cacheKeyVersion,
            cacheKeyHash: input.cacheKeyHash,
            normalizedUrl: input.normalizedUrl,
            normalizedUrlHash: input.normalizedUrlHash,
            renderProfileHash: input.renderProfileHash,
            status: 'pending',
            lastAttemptAt: input.now,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoNothing({
            target: [
              cacheEntries.organizationId,
              cacheEntries.projectId,
              cacheEntries.domainId,
              cacheEntries.cacheKeyVersion,
              cacheEntries.cacheKeyHash,
            ],
          })
          .returning();
        if (inserted[0]) return toRow(inserted[0]);

        const existing = await findCacheEntryByIdentity({
          organizationId: input.organizationId,
          projectId: input.projectId,
          domainId: input.domainId,
          cacheKeyVersion: input.cacheKeyVersion,
          cacheKeyHash: input.cacheKeyHash,
        });
        if (!existing) {
          throw new Error('cache entry insert conflicted but no existing row was found');
        }
        return existing;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw sanitizedError('createPendingCacheEntry', err);
        }
        throw err instanceof Error ? sanitizedError('createPendingCacheEntry', err) : err;
      }
    });
  }

  // Optimistic concurrency: the WHERE clause requires the row's current
  // generation to still equal expectedGeneration, and the SET clause bumps
  // it — both happen in one atomic UPDATE, so a stale writer (one that
  // read an older generation before a newer write already landed) affects
  // zero rows and gets null back, never overwriting the newer write.
  async function updateReadyCacheEntry(input: UpdateReadyCacheEntryInput): Promise<CacheEntryRow | null> {
    return timed('update_ready', async () => {
      const rows = await db
        .update(cacheEntries)
        .set({
          status: 'ready',
          storageKey: input.storageKey,
          contentHash: input.contentHash,
          contentEncoding: input.contentEncoding,
          contentBytes: input.contentBytes,
          responseStatus: input.responseStatus,
          renderedAt: input.renderedAt,
          freshUntil: input.freshUntil,
          staleUntil: input.staleUntil,
          lastAttemptAt: input.now,
          lastErrorCode: null,
          generation: sql`${cacheEntries.generation} + 1`,
          updatedAt: input.now,
        })
        .where(and(identityWhere(input), eq(cacheEntries.generation, input.expectedGeneration)))
        .returning();
      return rows[0] ? toRow(rows[0]) : null;
    });
  }

  async function updateFailedCacheEntry(input: UpdateFailedCacheEntryInput): Promise<CacheEntryRow | null> {
    return timed('update_failed', async () => {
      const rows = await db
        .update(cacheEntries)
        .set({
          status: 'failed',
          lastErrorCode: input.lastErrorCode,
          lastAttemptAt: input.now,
          generation: sql`${cacheEntries.generation} + 1`,
          updatedAt: input.now,
        })
        .where(and(identityWhere(input), eq(cacheEntries.generation, input.expectedGeneration)))
        .returning();
      return rows[0] ? toRow(rows[0]) : null;
    });
  }

  async function invalidateCacheEntry(input: InvalidateCacheEntryInput): Promise<CacheEntryRow | null> {
    return timed('invalidate', async () => {
      const rows = await db
        .update(cacheEntries)
        .set({
          status: 'invalidated',
          invalidatedAt: input.now,
          generation: sql`${cacheEntries.generation} + 1`,
          updatedAt: input.now,
        })
        .where(identityWhere(input))
        .returning();
      return rows[0] ? toRow(rows[0]) : null;
    });
  }

  return {
    findCacheEntryByIdentity,
    createPendingCacheEntry,
    updateReadyCacheEntry,
    updateFailedCacheEntry,
    invalidateCacheEntry,
  };
}
