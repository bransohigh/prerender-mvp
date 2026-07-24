import { describe, expect, it } from 'vitest';
import { CACHE_KEY_VERSION, computeCacheKey, computeNormalizedUrlHash, type CacheIdentity } from '../src/lib/cache-identity.js';

const SENTINEL_URL = 'https://example.test/account?token=TOP_SECRET_CACHE_SENTINEL';

function identity(overrides: Partial<CacheIdentity> = {}): CacheIdentity {
  return {
    organizationId: 'org_1',
    projectId: 'proj_1',
    domainId: 'dom_1',
    normalizedUrl: 'https://example.com/page',
    renderProfileHash: 'a'.repeat(64),
    ...overrides,
  };
}

describe('computeCacheKey', () => {
  it('is deterministic for identical input', () => {
    expect(computeCacheKey(identity())).toEqual(computeCacheKey(identity()));
  });

  it('defaults cacheKeyVersion to CACHE_KEY_VERSION', () => {
    expect(computeCacheKey(identity()).cacheKeyVersion).toBe(CACHE_KEY_VERSION);
  });

  it('produces a 64-char lowercase hex cacheKeyHash', () => {
    const { cacheKeyHash } = computeCacheKey(identity());
    expect(cacheKeyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when only organizationId differs (same project/domain/url)', () => {
    const a = computeCacheKey(identity({ organizationId: 'org_1' }));
    const b = computeCacheKey(identity({ organizationId: 'org_2' }));
    expect(a.cacheKeyHash).not.toBe(b.cacheKeyHash);
  });

  it('differs when only projectId differs', () => {
    const a = computeCacheKey(identity({ projectId: 'proj_1' }));
    const b = computeCacheKey(identity({ projectId: 'proj_2' }));
    expect(a.cacheKeyHash).not.toBe(b.cacheKeyHash);
  });

  it('differs when only domainId differs', () => {
    const a = computeCacheKey(identity({ domainId: 'dom_1' }));
    const b = computeCacheKey(identity({ domainId: 'dom_2' }));
    expect(a.cacheKeyHash).not.toBe(b.cacheKeyHash);
  });

  it('differs when only renderProfileHash differs', () => {
    const a = computeCacheKey(identity({ renderProfileHash: 'a'.repeat(64) }));
    const b = computeCacheKey(identity({ renderProfileHash: 'b'.repeat(64) }));
    expect(a.cacheKeyHash).not.toBe(b.cacheKeyHash);
  });

  it('differs when cacheKeyVersion differs', () => {
    const a = computeCacheKey(identity({ cacheKeyVersion: 1 }));
    const b = computeCacheKey(identity({ cacheKeyVersion: 2 }));
    expect(a.cacheKeyHash).not.toBe(b.cacheKeyHash);
  });

  it('is not vulnerable to naive field-boundary concatenation collisions', () => {
    // "orgA" + "projAB" vs "orgAproj" + "AB" would collide under plain
    // string concatenation without a separator; the NUL separator makes
    // these distinct.
    const a = computeCacheKey(identity({ organizationId: 'orgA', projectId: 'projAB' }));
    const b = computeCacheKey(identity({ organizationId: 'orgAproj', projectId: 'AB' }));
    expect(a.cacheKeyHash).not.toBe(b.cacheKeyHash);
  });

  it('same URL under two different projects produces different identities', () => {
    const a = computeCacheKey(identity({ projectId: 'proj_A' }));
    const b = computeCacheKey(identity({ projectId: 'proj_B' }));
    expect(a.cacheKeyHash).not.toBe(b.cacheKeyHash);
  });

  it('same URL under two different domains produces different identities', () => {
    const a = computeCacheKey(identity({ domainId: 'dom_A' }));
    const b = computeCacheKey(identity({ domainId: 'dom_B' }));
    expect(a.cacheKeyHash).not.toBe(b.cacheKeyHash);
  });

  it('computes a stable normalizedUrlHash independent of the other fields', () => {
    const a = computeCacheKey(identity({ organizationId: 'org_1' }));
    const b = computeCacheKey(identity({ organizationId: 'org_2' }));
    expect(a.normalizedUrlHash).toBe(b.normalizedUrlHash);
    expect(a.normalizedUrlHash).toBe(computeNormalizedUrlHash('https://example.com/page'));
  });

  it('never leaks the raw normalized URL in the computed key material', () => {
    const key = computeCacheKey(identity({ normalizedUrl: SENTINEL_URL }));
    expect(key.cacheKeyHash).not.toContain('TOP_SECRET_CACHE_SENTINEL');
    expect(key.normalizedUrlHash).not.toContain('TOP_SECRET_CACHE_SENTINEL');
    expect(JSON.stringify(key)).not.toContain('TOP_SECRET_CACHE_SENTINEL');
  });
});
