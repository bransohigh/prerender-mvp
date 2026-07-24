// Pure object-storage key builder for a future checkpoint — nothing in
// this codebase writes an object to this key yet (see CACHE_ARCHITECTURE.md).
// The key is built ONLY from server-generated UUIDs and a validated hex
// hash; it never contains the raw URL, hostname, path, query string, or
// any other user-controlled string, so "../" traversal and cross-tenant
// key collision are both structurally impossible, not just discouraged.

export type CacheContentEncoding = 'br' | 'gzip' | 'identity';

export interface BuildCacheStorageKeyParams {
  organizationId: string;
  projectId: string;
  domainId: string;
  cacheKeyHash: string;
  contentEncoding?: CacheContentEncoding;
}

export class InvalidCacheStorageKeyInputError extends Error {}

// Better Auth's own id charset (organizationId) is alphanumeric + `_`/`-`;
// this app's own uuid() columns (projectId/domainId) are also alnum + `-`.
// Both are covered by this one safe-segment pattern — deliberately
// rejects `.`, `/`, and every other character that could enable path
// traversal or segment injection, not just the literal substring "..".
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CACHE_KEY_HASH_RE = /^[0-9a-f]{64}$/;

function assertSafeSegment(value: string, label: string): void {
  if (!SAFE_SEGMENT_RE.test(value)) {
    throw new InvalidCacheStorageKeyInputError(`${label} must match ${SAFE_SEGMENT_RE} (got an invalid value)`);
  }
}

function extensionFor(encoding: CacheContentEncoding | undefined): string {
  switch (encoding) {
    case 'br':
      return '.html.br';
    case 'gzip':
      return '.html.gz';
    case 'identity':
    case undefined:
      return '.html';
  }
}

// cache/v1/{organizationId}/{projectId}/{domainId}/{prefix}/{cacheKeyHash}.html[.br|.gz]
// `prefix` is the first 2 hex characters of cacheKeyHash — spreads
// objects across subdirectories for any storage backend that benefits
// from that (avoids a single directory with millions of flat entries).
// Deterministic: the same inputs always produce the same key, so this
// function can be called independently by a writer and a reader without
// any side channel.
export function buildCacheStorageKey(params: BuildCacheStorageKeyParams): string {
  assertSafeSegment(params.organizationId, 'organizationId');
  assertSafeSegment(params.projectId, 'projectId');
  assertSafeSegment(params.domainId, 'domainId');
  if (!CACHE_KEY_HASH_RE.test(params.cacheKeyHash)) {
    throw new InvalidCacheStorageKeyInputError('cacheKeyHash must be a 64-character lowercase hex SHA-256 digest');
  }
  const prefix = params.cacheKeyHash.slice(0, 2);
  const ext = extensionFor(params.contentEncoding);
  return `cache/v1/${params.organizationId}/${params.projectId}/${params.domainId}/${prefix}/${params.cacheKeyHash}${ext}`;
}
