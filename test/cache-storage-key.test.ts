import { describe, expect, it } from 'vitest';
import { buildCacheStorageKey, InvalidCacheStorageKeyInputError } from '../src/lib/cache-storage-key.js';

const HASH = 'a'.repeat(64);

function params(overrides: Partial<Parameters<typeof buildCacheStorageKey>[0]> = {}) {
  return {
    organizationId: 'org_abc123',
    projectId: 'proj-abc-123',
    domainId: 'dom_ABC123',
    cacheKeyHash: HASH,
    ...overrides,
  };
}

describe('buildCacheStorageKey', () => {
  it('builds the documented key format with default (identity) encoding', () => {
    const key = buildCacheStorageKey(params());
    expect(key).toBe(`cache/v1/org_abc123/proj-abc-123/dom_ABC123/aa/${HASH}.html`);
  });

  it('uses .html.br for brotli encoding', () => {
    const key = buildCacheStorageKey(params({ contentEncoding: 'br' }));
    expect(key.endsWith('.html.br')).toBe(true);
  });

  it('uses .html.gz for gzip encoding', () => {
    const key = buildCacheStorageKey(params({ contentEncoding: 'gzip' }));
    expect(key.endsWith('.html.gz')).toBe(true);
  });

  it('is deterministic for identical input', () => {
    expect(buildCacheStorageKey(params())).toBe(buildCacheStorageKey(params()));
  });

  it('uses the first two hex characters of the hash as the prefix directory', () => {
    const hash = '0123456789abcdef'.repeat(4);
    const key = buildCacheStorageKey(params({ cacheKeyHash: hash }));
    expect(key).toContain(`/01/${hash}`);
  });

  it.each([
    ['../../etc/passwd', 'organizationId'],
    ['org/../secret', 'organizationId'],
    ['org/with/slash', 'organizationId'],
  ])('rejects traversal-style organizationId %s', (bad) => {
    expect(() => buildCacheStorageKey(params({ organizationId: bad }))).toThrow(InvalidCacheStorageKeyInputError);
  });

  it('rejects a projectId containing a path separator', () => {
    expect(() => buildCacheStorageKey(params({ projectId: 'proj/../x' }))).toThrow(InvalidCacheStorageKeyInputError);
  });

  it('rejects a domainId containing a dot-segment', () => {
    expect(() => buildCacheStorageKey(params({ domainId: '..' }))).toThrow(InvalidCacheStorageKeyInputError);
  });

  it('rejects an empty organizationId', () => {
    expect(() => buildCacheStorageKey(params({ organizationId: '' }))).toThrow(InvalidCacheStorageKeyInputError);
  });

  it('rejects a cacheKeyHash that is not 64 lowercase hex characters', () => {
    expect(() => buildCacheStorageKey(params({ cacheKeyHash: 'ABCDEF' }))).toThrow(InvalidCacheStorageKeyInputError);
    expect(() => buildCacheStorageKey(params({ cacheKeyHash: 'a'.repeat(63) }))).toThrow(InvalidCacheStorageKeyInputError);
    expect(() => buildCacheStorageKey(params({ cacheKeyHash: 'z'.repeat(64) }))).toThrow(InvalidCacheStorageKeyInputError);
  });

  it('never embeds a raw URL or hostname-shaped string since inputs are restricted to safe segments', () => {
    expect(() => buildCacheStorageKey(params({ organizationId: 'https://evil.example.com' }))).toThrow(
      InvalidCacheStorageKeyInputError,
    );
  });

  it('the produced key never contains a ".." sequence', () => {
    const key = buildCacheStorageKey(params());
    expect(key).not.toContain('..');
  });
});
