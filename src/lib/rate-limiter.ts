// Small, process-local, in-memory sliding-window rate limiter. Not a
// distributed limiter — under multiple app instances each has its own
// independent counters (documented limitation, same as the existing
// domain-verification rate limiter in domain-verification-service.ts).
// Redis-backed limiting is explicitly out of scope for this phase.
//
// Callers must never pass raw secret material (API keys, emails,
// invitation tokens) as the `key` argument — see
// src/lib/rate-limit-keys.ts for the keyed-digest helpers used to derive
// safe map keys from those values.

export interface RateLimiterOptions {
  windowMs: number;
  maxAttempts: number;
  /** Injectable for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the caller may retry — only meaningful when !allowed. */
  retryAfterSeconds: number;
  remaining: number;
}

interface Bucket {
  windowStart: number;
  count: number;
}

export interface RateLimiter {
  check: (key: string) => RateLimitDecision;
  /** Removes the bucket for `key` — used after a successful attempt so
   * success doesn't inherit a prior window's failure count forever. */
  reset: (key: string) => void;
  /** Drops expired buckets. Called periodically and on shutdown(). */
  cleanup: () => void;
  /** Stops the periodic cleanup timer. Call on app shutdown. */
  shutdown: () => void;
  /** Test/introspection only. */
  size: () => number;
}

const CLEANUP_INTERVAL_MS = 60_000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { windowMs, maxAttempts } = options;
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, Bucket>();

  function cleanup(): void {
    const nowMs = now();
    for (const [key, bucket] of buckets) {
      if (nowMs - bucket.windowStart >= windowMs) {
        buckets.delete(key);
      }
    }
  }

  const timer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  timer.unref?.();

  return {
    check(key: string): RateLimitDecision {
      const nowMs = now();
      const existing = buckets.get(key);

      if (!existing || nowMs - existing.windowStart >= windowMs) {
        buckets.set(key, { windowStart: nowMs, count: 1 });
        return { allowed: true, retryAfterSeconds: 0, remaining: maxAttempts - 1 };
      }

      if (existing.count >= maxAttempts) {
        const retryAfterMs = windowMs - (nowMs - existing.windowStart);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)), remaining: 0 };
      }

      existing.count += 1;
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.max(0, maxAttempts - existing.count) };
    },
    reset(key: string): void {
      buckets.delete(key);
    },
    cleanup,
    shutdown(): void {
      clearInterval(timer);
    },
    size(): number {
      return buckets.size;
    },
  };
}
