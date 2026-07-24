// Validated cache freshness policy — not yet wired to /v1/render (see
// CACHE_ARCHITECTURE.md). staleTtlSeconds is an ADDITIONAL window that
// starts when freshTtlSeconds ends (relative, not an absolute cutoff from
// renderedAt) — i.e. staleUntil = freshUntil + staleTtlSeconds — so it is
// always well-defined and always >= freshUntil, matching the
// cache_entries_stale_after_fresh_check database constraint.

export interface CachePolicy {
  freshTtlSeconds: number;
  staleTtlSeconds: number;
}

export const MIN_FRESH_TTL_SECONDS = 10;
export const MAX_FRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const MIN_STALE_TTL_SECONDS = 0; // 0 is valid: no stale-serving window at all
export const MAX_STALE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// Conservative defaults: a short fresh window (favors correctness/
// freshness over cache hit rate until real usage data justifies
// widening it) plus a modest stale-serving window to absorb origin
// hiccups without immediately falling back to a live render.
export const DEFAULT_CACHE_POLICY: CachePolicy = {
  freshTtlSeconds: 300, // 5 minutes
  staleTtlSeconds: 3600, // +1 hour beyond freshTtlSeconds
};

export class InvalidCachePolicyError extends Error {}

function assertBoundedInteger(value: number, label: string, min: number, max: number): void {
  if (!Number.isInteger(value)) {
    throw new InvalidCachePolicyError(`${label} must be an integer number of seconds (got ${value})`);
  }
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new InvalidCachePolicyError(`${label} must be between ${min} and ${max} seconds (got ${value})`);
  }
}

export function validateCachePolicy(policy: CachePolicy): CachePolicy {
  assertBoundedInteger(policy.freshTtlSeconds, 'freshTtlSeconds', MIN_FRESH_TTL_SECONDS, MAX_FRESH_TTL_SECONDS);
  assertBoundedInteger(policy.staleTtlSeconds, 'staleTtlSeconds', MIN_STALE_TTL_SECONDS, MAX_STALE_TTL_SECONDS);
  return policy;
}

export interface FreshnessWindow {
  freshUntil: Date;
  staleUntil: Date;
}

// renderedAt is the caller's clock value, never Date.now() — keeps this
// module consistent with the rest of the cache code's injectable-clock
// convention (src/lib/cache-state.ts).
export function computeFreshnessWindow(policy: CachePolicy, renderedAt: Date): FreshnessWindow {
  const validated = validateCachePolicy(policy);
  const freshUntil = new Date(renderedAt.getTime() + validated.freshTtlSeconds * 1000);
  const staleUntil = new Date(freshUntil.getTime() + validated.staleTtlSeconds * 1000);
  return { freshUntil, staleUntil };
}
