import type { DbClient } from './client.js';

const CACHE_MS = 3000;
const PING_TIMEOUT_MS = 1000;

// Wraps DbClient.ping() with a short cache so /readyz never runs a fresh
// query on every single request — a cheap `SELECT 1`, but still not free
// under high readiness-poll frequency (k8s probes, load balancer health
// checks, etc).
export function createDbReadinessCheck(db: DbClient): () => Promise<boolean> {
  let lastCheckedAt = 0;
  let lastResult = false;
  let inFlight: Promise<boolean> | null = null;

  return async (): Promise<boolean> => {
    const now = Date.now();
    if (now - lastCheckedAt < CACHE_MS) {
      return lastResult;
    }
    if (inFlight) {
      return inFlight;
    }
    inFlight = db
      .ping(PING_TIMEOUT_MS)
      .then((ok) => {
        lastResult = ok;
        lastCheckedAt = Date.now();
        return ok;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
