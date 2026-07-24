// Persisted lifecycle status (stored in cache_entries.status — see
// src/db/schema.ts's cacheEntryStatusEnum). "fresh"/"stale"/"expired" are
// deliberately NOT persisted statuses — they are derived purely from
// (freshUntil, staleUntil) vs. the current time by classifyCacheState
// below, so they can never drift out of sync with a stored boolean/enum.
export type CacheEntryPersistedStatus = 'pending' | 'ready' | 'failed' | 'invalidated';

// The full set of states a cache lookup can resolve to, including "miss"
// (no row at all) and "expired" (a ready row whose staleUntil has
// passed) — neither of which is a persisted status value.
export type CacheFreshnessState = 'miss' | 'pending' | 'fresh' | 'stale' | 'expired' | 'failed' | 'invalidated';

export interface CacheStateInput {
  status: CacheEntryPersistedStatus;
  freshUntil: Date | null;
  staleUntil: Date | null;
}

// Pure function — takes `now` as an explicit parameter (never calls
// Date.now()/new Date() internally) so callers can inject a fixed clock
// for deterministic boundary tests. `entry` is null for "no row found at
// all" (a cache miss), distinct from any persisted status.
//
// Boundary rules (all deterministic, no ambiguity at the exact instants):
//   no entry                                -> miss
//   status = 'pending'                      -> pending
//   status = 'failed'                       -> failed
//   status = 'invalidated'                  -> invalidated
//   status = 'ready' and now <  freshUntil  -> fresh
//   status = 'ready' and freshUntil <= now < staleUntil -> stale
//   status = 'ready' and now >= staleUntil  -> expired
export function classifyCacheState(entry: CacheStateInput | null, now: Date): CacheFreshnessState {
  if (!entry) return 'miss';

  switch (entry.status) {
    case 'pending':
      return 'pending';
    case 'failed':
      return 'failed';
    case 'invalidated':
      return 'invalidated';
    case 'ready': {
      const nowMs = now.getTime();
      if (entry.freshUntil && nowMs < entry.freshUntil.getTime()) return 'fresh';
      if (entry.staleUntil && nowMs < entry.staleUntil.getTime()) return 'stale';
      // A 'ready' row is only ever written with both freshUntil and
      // staleUntil set (enforced by cache_entries_ready_requires_content_check
      // — see src/db/schema.ts) — reaching here with either null would
      // mean a data-integrity violation slipped past that constraint;
      // treating it as 'expired' fails closed (never silently 'fresh').
      return 'expired';
    }
  }
}
