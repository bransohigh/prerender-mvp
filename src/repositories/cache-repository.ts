import type { CacheEntryPersistedStatus } from '../lib/cache-state.js';

// Every field here comes from a server-computed identity (see
// src/lib/cache-identity.ts) or server-validated tenant scope — never a
// raw client-controlled URL string alone. Callers must always supply the
// full org/project/domain scope; there is no unscoped-by-URL lookup.
export interface CacheEntryIdentityScope {
  organizationId: string;
  projectId: string;
  domainId: string;
  cacheKeyVersion: number;
  cacheKeyHash: string;
}

export interface CacheEntryRow {
  id: string;
  organizationId: string;
  projectId: string;
  domainId: string;
  cacheKeyVersion: number;
  cacheKeyHash: string;
  normalizedUrl: string;
  normalizedUrlHash: string;
  renderProfileHash: string;
  status: CacheEntryPersistedStatus;
  storageKey: string | null;
  contentHash: string | null;
  contentEncoding: string | null;
  contentBytes: number | null;
  responseStatus: number | null;
  renderedAt: Date | null;
  freshUntil: Date | null;
  staleUntil: Date | null;
  lastAttemptAt: Date | null;
  lastErrorCode: string | null;
  invalidatedAt: Date | null;
  generation: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePendingCacheEntryInput {
  organizationId: string;
  projectId: string;
  domainId: string;
  cacheKeyVersion: number;
  cacheKeyHash: string;
  normalizedUrl: string;
  normalizedUrlHash: string;
  renderProfileHash: string;
  now: Date;
}

export interface UpdateReadyCacheEntryInput extends CacheEntryIdentityScope {
  storageKey: string;
  contentHash: string;
  contentEncoding: string;
  contentBytes: number;
  responseStatus: number;
  renderedAt: Date;
  freshUntil: Date;
  staleUntil: Date;
  // Optimistic concurrency: the generation the caller last observed. The
  // update only applies if the stored row's generation still matches —
  // see src/repositories/postgres/cache-repository.ts for the atomic
  // compare-and-swap. A stale writer (one that read an older generation)
  // must never clobber a newer write.
  expectedGeneration: number;
  now: Date;
}

export interface UpdateFailedCacheEntryInput extends CacheEntryIdentityScope {
  lastErrorCode: string;
  expectedGeneration: number;
  now: Date;
}

export interface InvalidateCacheEntryInput extends CacheEntryIdentityScope {
  now: Date;
}

// Storage-provider-independent: this interface only ever persists
// metadata (see src/db/schema.ts's cacheEntries table) — it never reads
// or writes HTML/object-storage bytes, and no implementation may bind to
// an object-storage SDK. Not called from src/routes/render.ts yet (see
// CACHE_ARCHITECTURE.md — that wiring is a later checkpoint).
export interface CacheRepository {
  findCacheEntryByIdentity(scope: CacheEntryIdentityScope): Promise<CacheEntryRow | null>;
  createPendingCacheEntry(input: CreatePendingCacheEntryInput): Promise<CacheEntryRow>;
  // Returns null if expectedGeneration no longer matches the stored row
  // (someone else already wrote a newer generation) rather than throwing
  // — that is an expected, non-exceptional outcome for the caller to
  // handle (e.g. by re-reading), not a repository failure.
  updateReadyCacheEntry(input: UpdateReadyCacheEntryInput): Promise<CacheEntryRow | null>;
  updateFailedCacheEntry(input: UpdateFailedCacheEntryInput): Promise<CacheEntryRow | null>;
  invalidateCacheEntry(input: InvalidateCacheEntryInput): Promise<CacheEntryRow | null>;
}
