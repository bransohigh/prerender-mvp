import { describe, expect, it } from 'vitest';
import {
  computeFreshnessWindow,
  DEFAULT_CACHE_POLICY,
  InvalidCachePolicyError,
  MAX_FRESH_TTL_SECONDS,
  MAX_STALE_TTL_SECONDS,
  MIN_FRESH_TTL_SECONDS,
  MIN_STALE_TTL_SECONDS,
  validateCachePolicy,
} from '../src/lib/cache-policy.js';

describe('validateCachePolicy', () => {
  it('accepts the documented default policy', () => {
    expect(validateCachePolicy(DEFAULT_CACHE_POLICY)).toEqual(DEFAULT_CACHE_POLICY);
  });

  it('accepts the minimum boundary values', () => {
    expect(() => validateCachePolicy({ freshTtlSeconds: MIN_FRESH_TTL_SECONDS, staleTtlSeconds: MIN_STALE_TTL_SECONDS })).not.toThrow();
  });

  it('accepts the maximum boundary values', () => {
    expect(() => validateCachePolicy({ freshTtlSeconds: MAX_FRESH_TTL_SECONDS, staleTtlSeconds: MAX_STALE_TTL_SECONDS })).not.toThrow();
  });

  it('rejects freshTtlSeconds below the minimum', () => {
    expect(() => validateCachePolicy({ freshTtlSeconds: MIN_FRESH_TTL_SECONDS - 1, staleTtlSeconds: 0 })).toThrow(
      InvalidCachePolicyError,
    );
  });

  it('rejects freshTtlSeconds above the maximum', () => {
    expect(() => validateCachePolicy({ freshTtlSeconds: MAX_FRESH_TTL_SECONDS + 1, staleTtlSeconds: 0 })).toThrow(
      InvalidCachePolicyError,
    );
  });

  it('rejects staleTtlSeconds above the maximum', () => {
    expect(() => validateCachePolicy({ freshTtlSeconds: 300, staleTtlSeconds: MAX_STALE_TTL_SECONDS + 1 })).toThrow(
      InvalidCachePolicyError,
    );
  });

  it('rejects negative staleTtlSeconds', () => {
    expect(() => validateCachePolicy({ freshTtlSeconds: 300, staleTtlSeconds: -1 })).toThrow(InvalidCachePolicyError);
  });

  it('accepts staleTtlSeconds of exactly 0 (no stale-serving window)', () => {
    expect(() => validateCachePolicy({ freshTtlSeconds: 300, staleTtlSeconds: 0 })).not.toThrow();
  });

  it('rejects a non-integer freshTtlSeconds', () => {
    expect(() => validateCachePolicy({ freshTtlSeconds: 300.5, staleTtlSeconds: 0 })).toThrow(InvalidCachePolicyError);
  });

  it('rejects a non-integer staleTtlSeconds', () => {
    expect(() => validateCachePolicy({ freshTtlSeconds: 300, staleTtlSeconds: 10.1 })).toThrow(InvalidCachePolicyError);
  });

  it('rejects NaN', () => {
    expect(() => validateCachePolicy({ freshTtlSeconds: Number.NaN, staleTtlSeconds: 0 })).toThrow(InvalidCachePolicyError);
  });

  it('rejects Infinity (overflow)', () => {
    expect(() => validateCachePolicy({ freshTtlSeconds: 300, staleTtlSeconds: Number.POSITIVE_INFINITY })).toThrow(
      InvalidCachePolicyError,
    );
  });
});

describe('computeFreshnessWindow', () => {
  const renderedAt = new Date('2026-07-24T12:00:00.000Z');

  it('sets freshUntil to renderedAt + freshTtlSeconds', () => {
    const { freshUntil } = computeFreshnessWindow({ freshTtlSeconds: 300, staleTtlSeconds: 0 }, renderedAt);
    expect(freshUntil.getTime()).toBe(renderedAt.getTime() + 300_000);
  });

  it('sets staleUntil to freshUntil + staleTtlSeconds (additive, not absolute from renderedAt)', () => {
    const { freshUntil, staleUntil } = computeFreshnessWindow({ freshTtlSeconds: 300, staleTtlSeconds: 3600 }, renderedAt);
    expect(staleUntil.getTime()).toBe(freshUntil.getTime() + 3_600_000);
  });

  it('always produces staleUntil >= freshUntil, even with staleTtlSeconds of 0', () => {
    const { freshUntil, staleUntil } = computeFreshnessWindow({ freshTtlSeconds: 300, staleTtlSeconds: 0 }, renderedAt);
    expect(staleUntil.getTime()).toBeGreaterThanOrEqual(freshUntil.getTime());
  });

  it('throws for an invalid policy instead of silently clamping', () => {
    expect(() => computeFreshnessWindow({ freshTtlSeconds: 0, staleTtlSeconds: 0 }, renderedAt)).toThrow(InvalidCachePolicyError);
  });
});
