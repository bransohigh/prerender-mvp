import { describe, expect, it } from 'vitest';
import {
  assertCacheObjectKeyMatches,
  buildCacheObjectKey,
  InvalidCacheStorageKeyInputError,
  parseCacheObjectKey,
} from '../src/lib/cache-storage-key.js';

const HASH = 'a'.repeat(64);
const CONTENT_HASH = 'b'.repeat(64);

function params(overrides: Partial<Parameters<typeof buildCacheObjectKey>[0]> = {}) {
  return {
    organizationId: 'org_abc123',
    projectId: 'proj-abc-123',
    domainId: 'dom_ABC123',
    cacheKeyHash: HASH,
    generation: 1,
    contentHash: CONTENT_HASH,
    ...overrides,
  };
}

describe('buildCacheObjectKey', () => {
  it('builds the documented immutable key format with default (identity) encoding', () => {
    const key = buildCacheObjectKey(params());
    expect(key).toBe(`cache/v1/org_abc123/proj-abc-123/dom_ABC123/aa/${HASH}/g1-${CONTENT_HASH}.html`);
  });

  it('uses .html.br for brotli encoding', () => {
    const key = buildCacheObjectKey(params({ contentEncoding: 'br' }));
    expect(key.endsWith('.html.br')).toBe(true);
  });

  it('uses .html.gz for gzip encoding', () => {
    const key = buildCacheObjectKey(params({ contentEncoding: 'gzip' }));
    expect(key.endsWith('.html.gz')).toBe(true);
  });

  it('is deterministic for identical input', () => {
    expect(buildCacheObjectKey(params())).toBe(buildCacheObjectKey(params()));
  });

  it('uses the first two hex characters of the hash as the prefix directory', () => {
    const hash = '0123456789abcdef'.repeat(4);
    const key = buildCacheObjectKey(params({ cacheKeyHash: hash }));
    expect(key).toContain(`/01/${hash}/`);
  });

  it('produces a different key for a different generation', () => {
    const g1 = buildCacheObjectKey(params({ generation: 1 }));
    const g2 = buildCacheObjectKey(params({ generation: 2 }));
    expect(g1).not.toBe(g2);
  });

  it('produces a different key for a different content hash', () => {
    const a = buildCacheObjectKey(params({ contentHash: 'b'.repeat(64) }));
    const b = buildCacheObjectKey(params({ contentHash: 'c'.repeat(64) }));
    expect(a).not.toBe(b);
  });

  it('rejects generation zero', () => {
    expect(() => buildCacheObjectKey(params({ generation: 0 }))).toThrow(InvalidCacheStorageKeyInputError);
  });

  it('rejects a negative generation', () => {
    expect(() => buildCacheObjectKey(params({ generation: -1 }))).toThrow(InvalidCacheStorageKeyInputError);
  });

  it('rejects a non-integer generation', () => {
    expect(() => buildCacheObjectKey(params({ generation: 1.5 }))).toThrow(InvalidCacheStorageKeyInputError);
  });

  it.each([
    ['../../etc/passwd', 'organizationId'],
    ['org/../secret', 'organizationId'],
    ['org/with/slash', 'organizationId'],
  ])('rejects traversal-style organizationId %s', (bad) => {
    expect(() => buildCacheObjectKey(params({ organizationId: bad }))).toThrow(InvalidCacheStorageKeyInputError);
  });

  it('rejects a projectId containing a path separator', () => {
    expect(() => buildCacheObjectKey(params({ projectId: 'proj/../x' }))).toThrow(InvalidCacheStorageKeyInputError);
  });

  it('rejects a domainId containing a dot-segment', () => {
    expect(() => buildCacheObjectKey(params({ domainId: '..' }))).toThrow(InvalidCacheStorageKeyInputError);
  });

  it('rejects an empty organizationId', () => {
    expect(() => buildCacheObjectKey(params({ organizationId: '' }))).toThrow(InvalidCacheStorageKeyInputError);
  });

  it('rejects a cacheKeyHash that is not 64 lowercase hex characters', () => {
    expect(() => buildCacheObjectKey(params({ cacheKeyHash: 'ABCDEF' }))).toThrow(InvalidCacheStorageKeyInputError);
    expect(() => buildCacheObjectKey(params({ cacheKeyHash: 'a'.repeat(63) }))).toThrow(InvalidCacheStorageKeyInputError);
  });

  it('rejects a malformed contentHash', () => {
    expect(() => buildCacheObjectKey(params({ contentHash: 'not-a-hash' }))).toThrow(InvalidCacheStorageKeyInputError);
    expect(() => buildCacheObjectKey(params({ contentHash: 'z'.repeat(64) }))).toThrow(InvalidCacheStorageKeyInputError);
  });

  it('never embeds a raw URL or hostname-shaped string since inputs are restricted to safe segments', () => {
    expect(() => buildCacheObjectKey(params({ organizationId: 'https://evil.example.com' }))).toThrow(
      InvalidCacheStorageKeyInputError,
    );
  });

  it('the produced key never contains a ".." sequence', () => {
    expect(buildCacheObjectKey(params())).not.toContain('..');
  });
});

describe('parseCacheObjectKey', () => {
  it('round-trips a key built by buildCacheObjectKey', () => {
    const key = buildCacheObjectKey(params({ contentEncoding: 'br' }));
    const parsed = parseCacheObjectKey(key);
    expect(parsed).toEqual({
      organizationId: 'org_abc123',
      projectId: 'proj-abc-123',
      domainId: 'dom_ABC123',
      cacheKeyHash: HASH,
      generation: 1,
      contentHash: CONTENT_HASH,
      contentEncoding: 'br',
    });
  });

  it('rejects a key with a mismatched prefix/hash pair', () => {
    const key = buildCacheObjectKey(params()).replace(`/aa/${HASH}/`, `/bb/${HASH}/`);
    expect(() => parseCacheObjectKey(key)).toThrow(InvalidCacheStorageKeyInputError);
  });

  it('rejects an arbitrary non-conforming string', () => {
    expect(() => parseCacheObjectKey('../../etc/passwd')).toThrow(InvalidCacheStorageKeyInputError);
    expect(() => parseCacheObjectKey('cache/v1/a/b/c/aa/notahash/g1-' + CONTENT_HASH + '.html')).toThrow(
      InvalidCacheStorageKeyInputError,
    );
  });

  it('rejects a key with an unrecognized extension', () => {
    const key = buildCacheObjectKey(params()).replace(/\.html$/, '.txt');
    expect(() => parseCacheObjectKey(key)).toThrow(InvalidCacheStorageKeyInputError);
  });
});

describe('assertCacheObjectKeyMatches', () => {
  it('passes when the key matches the expected metadata', () => {
    const key = buildCacheObjectKey(params({ generation: 2, contentEncoding: 'gzip' }));
    expect(() =>
      assertCacheObjectKeyMatches(key, { cacheKeyHash: HASH, generation: 2, contentHash: CONTENT_HASH, contentEncoding: 'gzip' }),
    ).not.toThrow();
  });

  it('a stale generation cannot pass validation against the active generation', () => {
    const staleKey = buildCacheObjectKey(params({ generation: 1 }));
    expect(() =>
      assertCacheObjectKeyMatches(staleKey, { cacheKeyHash: HASH, generation: 2, contentHash: CONTENT_HASH, contentEncoding: 'identity' }),
    ).toThrow(InvalidCacheStorageKeyInputError);
  });

  it('rejects a mismatched content hash', () => {
    const key = buildCacheObjectKey(params({ contentHash: 'b'.repeat(64) }));
    expect(() =>
      assertCacheObjectKeyMatches(key, { cacheKeyHash: HASH, generation: 1, contentHash: 'c'.repeat(64), contentEncoding: 'identity' }),
    ).toThrow(InvalidCacheStorageKeyInputError);
  });
});
