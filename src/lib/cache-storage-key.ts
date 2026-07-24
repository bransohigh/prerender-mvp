// Immutable, content-addressed object-storage key builder (Phase 8A-2).
// See CACHE_ARCHITECTURE.md. The key embeds the entry's generation AND its
// content hash, so a stale writer that lost an optimistic-concurrency race
// (see src/repositories/postgres/cache-repository.ts) computes a
// DIFFERENT key than the generation that actually won — it can never
// address, and therefore can never overwrite, the bytes an already-committed
// newer generation's metadata row points to. The key, once referenced by a
// `ready` cache_entries row, must never be recomputed or reused for
// different bytes.

export type CacheContentEncoding = 'br' | 'gzip' | 'identity';

export interface BuildCacheObjectKeyParams {
  organizationId: string;
  projectId: string;
  domainId: string;
  cacheKeyHash: string;
  generation: number;
  contentHash: string;
  contentEncoding?: CacheContentEncoding;
}

export interface ParsedCacheObjectKey {
  organizationId: string;
  projectId: string;
  domainId: string;
  cacheKeyHash: string;
  generation: number;
  contentHash: string;
  contentEncoding: CacheContentEncoding;
}

export class InvalidCacheStorageKeyInputError extends Error {}

// Better Auth's own id charset (organizationId) is alphanumeric + `_`/`-`;
// this app's own uuid() columns (projectId/domainId) are also alnum + `-`.
// Both are covered by this one safe-segment pattern — deliberately
// rejects `.`, `/`, and every other character that could enable path
// traversal or segment injection, not just the literal substring "..".
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

function assertSafeSegment(value: string, label: string): void {
  if (!SAFE_SEGMENT_RE.test(value)) {
    throw new InvalidCacheStorageKeyInputError(`${label} must match ${SAFE_SEGMENT_RE} (got an invalid value)`);
  }
}

function assertHex64(value: string, label: string): void {
  if (!HEX64_RE.test(value)) {
    throw new InvalidCacheStorageKeyInputError(`${label} must be a 64-character lowercase hex SHA-256 digest`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidCacheStorageKeyInputError(`${label} must be a positive integer (got ${value})`);
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

function encodingForExtension(ext: string): CacheContentEncoding | null {
  switch (ext) {
    case '.html.br':
      return 'br';
    case '.html.gz':
      return 'gzip';
    case '.html':
      return 'identity';
    default:
      return null;
  }
}

// cache/v1/{organizationId}/{projectId}/{domainId}/{prefix}/{cacheKeyHash}/g{generation}-{contentHash}.html[.br|.gz]
// `prefix` is the first 2 hex characters of cacheKeyHash — spreads
// objects across subdirectories for any storage backend that benefits
// from that. `g{generation}-{contentHash}` is the immutable, versioned
// filename: every (generation, contentHash) pair addresses a distinct
// object, so re-rendering the same identity always writes a brand-new
// key rather than mutating bytes an already-`ready` row may be actively
// serving. Deterministic: identical inputs always produce identical keys.
export function buildCacheObjectKey(params: BuildCacheObjectKeyParams): string {
  assertSafeSegment(params.organizationId, 'organizationId');
  assertSafeSegment(params.projectId, 'projectId');
  assertSafeSegment(params.domainId, 'domainId');
  assertHex64(params.cacheKeyHash, 'cacheKeyHash');
  assertPositiveInteger(params.generation, 'generation');
  assertHex64(params.contentHash, 'contentHash');

  const prefix = params.cacheKeyHash.slice(0, 2);
  const ext = extensionFor(params.contentEncoding);
  return `cache/v1/${params.organizationId}/${params.projectId}/${params.domainId}/${prefix}/${params.cacheKeyHash}/g${params.generation}-${params.contentHash}${ext}`;
}

const KEY_RE =
  /^cache\/v1\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\/([0-9a-f]{2})\/([0-9a-f]{64})\/g([0-9]+)-([0-9a-f]{64})(\.html(?:\.br|\.gz)?)$/;

// Server-side validation for a storage key read back from a metadata row
// — never trust string construction alone once a key crosses a process
// boundary (e.g. round-tripped through the database). Rejects anything
// that doesn't match the exact expected shape, including a mismatched
// prefix/hash pair, a non-numeric or non-positive generation, or an
// unrecognized extension.
export function parseCacheObjectKey(key: string): ParsedCacheObjectKey {
  const match = KEY_RE.exec(key);
  if (!match) {
    throw new InvalidCacheStorageKeyInputError('storage key does not match the expected immutable cache object key format');
  }
  const [, organizationId, projectId, domainId, prefix, cacheKeyHash, generationStr, contentHash, ext] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!cacheKeyHash.startsWith(prefix)) {
    throw new InvalidCacheStorageKeyInputError('storage key prefix does not match cacheKeyHash');
  }
  const generation = Number.parseInt(generationStr, 10);
  assertPositiveInteger(generation, 'generation');
  const contentEncoding = encodingForExtension(ext);
  if (!contentEncoding) {
    throw new InvalidCacheStorageKeyInputError('storage key has an unrecognized encoding extension');
  }
  return { organizationId, projectId, domainId, cacheKeyHash, generation, contentHash, contentEncoding };
}

export function assertCacheObjectKeyMatches(
  key: string,
  expected: { cacheKeyHash: string; generation: number; contentHash: string; contentEncoding: CacheContentEncoding },
): void {
  const parsed = parseCacheObjectKey(key);
  if (
    parsed.cacheKeyHash !== expected.cacheKeyHash ||
    parsed.generation !== expected.generation ||
    parsed.contentHash !== expected.contentHash ||
    parsed.contentEncoding !== expected.contentEncoding
  ) {
    throw new InvalidCacheStorageKeyInputError('storage key does not match the expected metadata (generation/content hash/encoding)');
  }
}
