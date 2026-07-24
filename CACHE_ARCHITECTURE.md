# Cache Architecture (Phase 8A-1 + 8A-2: identity, metadata, and object storage foundation)

This document covers two checkpoints: the cache **metadata model**
(Phase 8A-1) and the **immutable HTML object-storage foundation**
(Phase 8A-2). Together they let a caller durably commit and read back
rendered HTML through `src/services/cache-storage-service.ts`, but this
still does not describe a working cache from a client's perspective:
`/v1/render` does not consult or populate any of this yet, and no HTTP
route serves cached HTML. See "Explicitly out of scope" below.

## Cache identity

A cache entry is identified by five values, defined in
[`src/lib/cache-identity.ts`](src/lib/cache-identity.ts):

- `organizationId`, `projectId`, `domainId` — full tenant scope
- `normalizedUrl` — see "URL normalization" below
- `renderProfileHash` — see "Render profile fingerprint" below

These are combined into a deterministic `CacheKey`:

```
cacheKeyHash = sha256(
  cacheKeyVersion + NUL + organizationId + NUL + projectId + NUL +
  domainId + NUL + normalizedUrl + NUL + renderProfileHash
)
```

The join uses a literal NUL byte (`\x00`) as a field separator, not a
printable character. A printable delimiter (e.g. `|` or a plain
concatenation) could theoretically appear inside a query string or id and
create a field-boundary collision; NUL cannot appear in any of these
fields, so the boundaries are unambiguous.

`CACHE_KEY_VERSION` is a separate integer, exported alongside the formula.
Bump it if the key **formula** itself changes in a way that must
invalidate every existing identity (distinct from `RENDER_PROFILE_VERSION`,
which is for renderer-behavior changes — see below). The same URL under two
different projects, or two different domains, always produces a different
`cacheKeyHash`, because `projectId`/`domainId` are part of the hashed
input.

## URL normalization

Cache identity reuses the renderer's own validated URL policy
([`src/lib/url-normalize.ts`](src/lib/url-normalize.ts)) via
`normalizeUrlForCache` — there is intentionally no second URL parser for
the cache layer, so cache identity can never disagree with what the
renderer actually fetched. Notable normalization behavior (inherited from
that module and the underlying WHATWG `URL` parser):

- Only `https:` is accepted (the renderer never allows plain `http:`).
- Only port 443 (or no port) is accepted — non-default ports are rejected
  outright, not preserved, because the render-time domain policy never
  allows one.
- Scheme and hostname are lowercased; the WHATWG parser also
  auto-converts IDN/Unicode hostnames to their ASCII punycode form before
  that lowercasing.
- Credentials (`user:pass@`) are rejected, not silently stripped.
- Fragments are removed.
- An empty path normalizes to `/`; path **case is preserved** otherwise.
- Query strings are preserved **verbatim** — no key sorting, no stripping,
  no re-encoding of percent-escaped reserved characters.
- The hostname must match the domain the request is scoped to
  (`host_mismatch` is rejected), so a cache identity can never be built
  for a hostname outside the caller's verified domain.

## Render profile fingerprint

[`src/lib/render-profile.ts`](src/lib/render-profile.ts) hashes only a
fixed, allowlisted set of fields that can actually change the rendered
HTML for a given URL:

- `waitStrategy`, `timeoutProfile`, `userAgentProfile`,
  `javascriptEnabled`, `resourceBlockingProfile`

It never includes `requestId`, API key material, user/organization
identifiers, timestamps, logging options, or any other field — the
allowlist is the TypeScript input type itself, so there is no code path
for an extra property to reach the hash. Canonicalization uses
`JSON.stringify(value, explicitKeyOrderArray)` (the replacer-array form),
which fixes key order regardless of the input object's own property
order, so two logically-identical profiles always hash identically.
`RENDER_PROFILE_VERSION` is bumped when renderer behavior changes in a way
that affects output for an *existing* profile input (e.g. a Chromium
upgrade) — this invalidates every prior identity built with the old
version even though none of the allowlisted fields changed.

## Cache entry state model

Two different concepts, both in
[`src/lib/cache-state.ts`](src/lib/cache-state.ts):

- **Persisted status** (`cache_entries.status`): `pending` | `ready` |
  `failed` | `invalidated`. This is the only thing ever written to the
  database column.
- **Freshness state** (`classifyCacheState()` return value): `miss` |
  `pending` | `fresh` | `stale` | `expired` | `failed` | `invalidated`.
  `fresh`/`stale`/`expired` are **never persisted** — they are derived
  purely from `(freshUntil, staleUntil)` versus an explicitly-passed
  `now: Date`, so freshness can never drift out of sync with a stored
  boolean/enum. The function never calls `Date.now()` internally
  (injectable-clock convention, matching `src/lib/rate-limiter.ts`).

Boundary rules for a `ready` entry:

```
now <  freshUntil               -> fresh
freshUntil <= now < staleUntil  -> stale
now >= staleUntil               -> expired
```

## Cache policy (TTL)

[`src/lib/cache-policy.ts`](src/lib/cache-policy.ts) defines
`freshTtlSeconds`/`staleTtlSeconds`, both bounded integers (min 10s / 0s,
max 30 days), validated by `validateCachePolicy()`.
`staleTtlSeconds` is an **additive** window that starts when
`freshTtlSeconds` ends — `staleUntil = freshUntil + staleTtlSeconds` — not
an absolute cutoff measured from `renderedAt`. This guarantees
`staleUntil >= freshUntil` unconditionally, matching the database's
`cache_entries_stale_after_fresh_check` constraint. `DEFAULT_CACHE_POLICY`
is a conservative 5-minute fresh window plus a 1-hour stale window,
favoring correctness over hit rate until real traffic data justifies
widening it. This policy is defined but **not yet consulted by any code
path** — see "Explicitly out of scope."

## PostgreSQL schema and tenant isolation

Table: `cache_entries` (migration `drizzle/0006_cache_entries.sql`,
defined in [`src/db/schema.ts`](src/db/schema.ts)). It stores **metadata
only** — never raw HTML, response bodies, cookies, headers, or API keys.

Tenant consistency is enforced at the database level, not just in
application code. Two new composite `UNIQUE` constraints were added to
existing tables:

- `projects_id_organization_id_unique` on `(projects.id, projects.organization_id)`
- `domains_id_project_id_unique` on `(domains.id, domains.project_id)`

`cache_entries` then declares two composite foreign keys against those:

- `(project_id, organization_id) → projects(id, organization_id)`
- `(domain_id, project_id) → domains(id, project_id)`

This makes it a **database-level impossibility** — not an app-level check
that could be bypassed by a bug — to insert a `cache_entries` row where
`project_id` belongs to one organization but `domain_id` belongs to a
project under a different organization, or where `domain_id` doesn't
actually belong to `project_id`. `domains` itself has no direct
`organization_id` column (only via `projects`), which is exactly why the
two-hop composite-FK chain is needed instead of a single direct FK.

Uniqueness: one row per
`(organization_id, project_id, domain_id, cache_key_version, cache_key_hash)`
(`cache_entries_identity_unique`).

Indexes: an exact-lookup index matching the identity scope
(`cache_entries_lookup_idx`), plus `project_id`/`domain_id`/
`(status, fresh_until)` indexes anticipating future listing and
freshness-maintenance queries. No further speculative indexes were added.

Check constraints enforce, at the database level, everything the
application layer also validates: `generation >= 1`; `content_bytes >= 0`
or null; `response_status` in `[100, 600)` or null; `stale_until >=
fresh_until` (when both are set); a `ready` row must have `storage_key`,
`content_hash`, `rendered_at`, `fresh_until`, and `stale_until` all set;
a `pending` row must have `storage_key`/`content_hash` both null; an
`invalidated` row must have `invalidated_at` set; `cache_key_hash`,
`normalized_url_hash`, `render_profile_hash`, and `content_hash` (when
present) must each match `^[0-9a-f]{64}$`; `storage_key` must not contain
`..`.

## Repository layer and concurrency

[`src/repositories/cache-repository.ts`](src/repositories/cache-repository.ts)
defines a storage-provider-independent interface:
`findCacheEntryByIdentity`, `createPendingCacheEntry`,
`updateReadyCacheEntry`, `updateFailedCacheEntry`, `invalidateCacheEntry`.
Every operation requires the full tenant scope; there is no lookup by URL
alone.

[`src/repositories/postgres/cache-repository.ts`](src/repositories/postgres/cache-repository.ts)
implements it:

- `createPendingCacheEntry` uses a single `INSERT ... ON CONFLICT DO
  NOTHING` targeting the identity unique index — atomic, no
  read-then-insert race between two concurrent renders of the same
  identity. If the conflict branch fires, a follow-up `SELECT` returns the
  row that's already there (a plain read of already-committed data, not a
  correctness-sensitive race).
- `updateReadyCacheEntry` / `updateFailedCacheEntry` use optimistic
  concurrency: the `UPDATE`'s `WHERE` clause requires
  `generation = expectedGeneration`, and its `SET` clause bumps
  `generation` in the same statement. A stale writer (one that read an
  older generation before a newer write already landed) matches zero
  rows and receives `null` back — it can never silently overwrite a
  newer write. Generation therefore only ever increases.
- Driver errors are sanitized before they leave the repository (same
  pattern as `src/repositories/postgres/tenant-repository.ts`): only the
  error's constructor name is surfaced, never raw driver detail that
  could echo back bound parameter values.
- **No distributed locking is implemented in this checkpoint.**
  Duplicate-render suppression across concurrent requests for the same
  cold identity belongs to Phase 8C.

## Storage key format (immutable, content-addressed — Phase 8A-2)

[`src/lib/cache-storage-key.ts`](src/lib/cache-storage-key.ts) defines the
**immutable** object key format:

```
cache/v1/{organizationId}/{projectId}/{domainId}/{prefix}/{cacheKeyHash}/g{generation}-{contentHash}.html[.br|.gz]
```

This replaces the Phase 8A-1 identity-only key
(`.../{cacheKeyHash}.html.br`), which was never used to write anything
and would have been unsafe to use for real writes: a stale worker that
lost an optimistic-concurrency race could otherwise recompute the exact
same key as the winner and overwrite its bytes after the winner's
metadata row already pointed to them. The new key embeds **both** the
entry's `generation` and the object's `contentHash`, so:

- a stale writer (one still holding an old `expectedGeneration`) computes
  the *new* generation as `expectedGeneration + 1` when building its key
  — but if it lost the race, the metadata update it depends on fails
  first (see "Cache storage service" below), and its object write, even
  though it may have already landed under a *different* key than the
  winner's, is never referenced by any `ready` row and is best-effort
  cleaned up;
- two different generations of the same identity always occupy different
  keys, so an old generation's bytes are never at risk of being
  overwritten by a new generation's write.

`prefix` is still the first two hex characters of `cacheKeyHash`. Every
input is validated: `organizationId`/`projectId`/`domainId` against
`^[A-Za-z0-9_-]{1,64}$` (never the raw URL, hostname, path, or query
string), `cacheKeyHash`/`contentHash` against `^[0-9a-f]{64}$`, and
`generation` as a positive integer — `.` and `/` cannot appear in any
input, making `../` traversal structurally impossible. `parseCacheObjectKey()`
performs the reverse operation — parsing and validating a key read back
from a database row rather than trusting string construction alone — and
`assertCacheObjectKeyMatches()` verifies a parsed key's fields against a
cache entry's own metadata (used on every read; see "Read-path integrity
verification" below). The key, once referenced by a `ready` row, is never
recomputed for the same generation or reused for different bytes. This
module does not bind to any object-storage SDK type.

## Content hash semantics

[`src/lib/html-content-hash.ts`](src/lib/html-content-hash.ts):
`contentHash` is always `sha256(Buffer.from(html, "utf8"))` — the
**uncompressed** HTML, hashed as explicit UTF-8 bytes, never an implicit
or ambiguous string encoding. Storage bytes may be Brotli- or
gzip-encoded (see "Compression and size limits" below); after an object
is read back and decoded, re-hashing the decoded HTML must reproduce this
same value — that equality check is exactly what
`readReadyHtml()` in the cache storage service performs before returning
anything to a caller (via `contentHashesMatch()`, a constant-time
comparison). `contentHash` deliberately excludes `requestId`, timestamps,
storage headers, API keys, cookies, the URL, and any compression
metadata — none of those are part of "what HTML was rendered".

## Compression and size limits

[`src/lib/html-compression.ts`](src/lib/html-compression.ts) supports a
fixed three-value encoding enum: `br` (default/preferred), `gzip`, and
`identity` (uncompressed — for tests/debugging only). Compression
settings are fixed constants, never derived from request input (Brotli
quality 5 + text mode; gzip level 6). Decompression is bounded: both the
Brotli and gzip decoders are called with a `maxOutputLength` set to the
configured `maxDecompressedReadBytes`, which is the actual defense
against a decompression bomb — a small compressed object cannot expand
into an unbounded in-memory buffer. Corrupt or truncated compressed data
and a size-limit violation are each normalized into their own typed error
(`CorruptCompressedDataError`, `DecompressedSizeLimitExceededError`)
rather than letting a raw zlib error (which can include buffer-state
details) propagate.

[`src/lib/cache-object-limits.ts`](src/lib/cache-object-limits.ts) defines
three centralized, validated byte limits — `maxUncompressedHtmlBytes`,
`maxStoredObjectBytes`, `maxDecompressedReadBytes` — each a bounded
integer (1 byte to a 50MB ceiling), with conservative 10MB defaults
mirroring the existing render-time `MAX_HTML_BYTES` posture (see
`src/config/env.ts`). The cache storage service enforces
`maxUncompressedHtmlBytes` before compressing, `maxStoredObjectBytes`
after compressing (and again before decompressing on read), and
`maxDecompressedReadBytes` while decompressing on read. Tests cover
multibyte UTF-8 HTML explicitly, so character count is never confused
with byte count anywhere in this pipeline.

## HTML object-store interface, adapters, and provider configuration

[`src/repositories/html-object-store.ts`](src/repositories/html-object-store.ts)
defines a provider-independent `HtmlObjectStore` interface —
`putObject`/`getObject`/`headObject`/`deleteObject` — using only domain
types (`PutHtmlObjectInput`, `StoredHtmlObject`, `HtmlObjectMetadata`,
`ObjectStorageError`). No AWS/Cloudflare/filesystem-specific type crosses
this boundary. Every operation takes an already-validated, server-generated
storage key. Objects are never public — the interface has no concept of
a public URL, and both adapters below keep stored bytes private.

- [`src/repositories/memory-html-object-store.ts`](src/repositories/memory-html-object-store.ts) —
  fast in-process adapter for unit/service tests. Models the same
  immutable-key and not-found semantics as the real adapter, plus
  injectable put/delete failure hooks for exercising rollback/cleanup
  paths. Never used in production (see provider validation below).
- [`src/repositories/filesystem-html-object-store.ts`](src/repositories/filesystem-html-object-store.ts) —
  local-filesystem adapter for development/test. Every write goes to a
  temp file in the same directory, is `fsync`'d, then atomically renamed
  into place (`fs.rename` is atomic within one filesystem), so a reader
  never observes a partial object. Writes use mode `0600`; created
  directories use mode `0700`. The resolved final path is re-checked to
  remain inside the configured root even though the storage key is
  already validated (defense in depth). Every path segment on the way to
  the target — and the target itself — is checked with `lstat` and
  rejected if it is a symlink, blocking both a symlink planted directly
  at the target and a symlink substituted for an intermediate directory.
  A missing object returns `null` (typed not-found), never throws.
  Deletion is idempotent. A failed write cleans up its temp file before
  the error propagates.

`CACHE_OBJECT_STORE_PROVIDER` (`filesystem` | `memory`, default `memory`)
and `CACHE_OBJECT_STORE_ROOT` (required, must be an absolute path, only
when the provider is `filesystem`) are validated at startup in
`src/config/env.ts`. `NODE_ENV=production` with
`CACHE_OBJECT_STORE_PROVIDER=memory` fails Zod parsing immediately
(fails closed, matching every other security-relevant env var in this
file) — there is no silent fallback to in-memory storage in production.
Nothing defaults the filesystem root to the application's own repository
directory. No S3/R2 (or any other cloud-provider) adapter exists yet;
adding one is out of scope for this checkpoint.

## Cache storage service

[`src/services/cache-storage-service.ts`](src/services/cache-storage-service.ts)
coordinates the metadata repository (Phase 8A-1) and the HTML object
store (this checkpoint) without touching `/v1/render`. Every public
method takes a full, trusted `CacheIdentity` object rather than loose
`organizationId`/`projectId`/`domainId` strings, so a caller can't
accidentally assemble a scope from unrelated fields.

**`commitRenderedHtml(...)`** — the write path:

1. Validate the uncompressed HTML byte length against
   `maxUncompressedHtmlBytes`.
2. Compute `contentHash` over the uncompressed bytes.
3. Compress the HTML (default `br`).
4. Validate the compressed byte length against `maxStoredObjectBytes`.
5. Build the immutable object key using `newGeneration = expectedGeneration + 1`
   and the computed `contentHash`.
6. Write the object. **If this fails, metadata is never touched** —
   `storageKey`/`contentHash`/`contentBytes` remain unset on the existing
   `pending` row, and the failure propagates as a real error, never as
   something that looks like a cache miss.
7. Update the metadata row to `ready` via
   `updateReadyCacheEntry(..., expectedGeneration)` — the same
   optimistic-concurrency compare-and-swap described in the Phase 8A-1
   section above.
8. If that update returns `null` (lost the race — some other writer
   already committed a newer generation), the object written in step 6
   must never become active: the service best-effort deletes it
   (`bestEffortCleanup`). If cleanup itself fails, the object is logged
   as an orphan (`cache.object.cleanup.failure`) and left in place — an
   orphan is an acceptable outcome; overwriting or otherwise touching the
   *active* object is never acceptable. The service returns
   `{ outcome: 'conflict' }` rather than throwing, since losing an
   optimistic-concurrency race is an expected, non-exceptional outcome
   for the caller to handle.
9. On success, returns `{ outcome: 'success', entry }` only after the
   metadata update has actually committed.

**`markRenderFailed(...)`** transitions a pending entry to `failed` via
`updateFailedCacheEntry` — no object-store interaction.

**`readReadyHtml(...)`** — the read path, described in detail below.

**`invalidateEntry(...)`** transitions an entry to `invalidated` —
metadata only; see "Invalidation" below.

No distributed lock is implemented — two concurrent cold renders of the
same identity can both attempt `commitRenderedHtml`, and exactly one of
them wins the metadata update; this checkpoint relies on that same
Phase 8A-1 optimistic-concurrency guarantee rather than adding
duplicate-render suppression (still deferred to Phase 8C).

## Read-path integrity verification

`readReadyHtml(...)` never trusts a database row at face value:

1. Requires `entry.status === 'ready'` — anything else (`pending`,
   `failed`, `invalidated`, or no row at all) throws
   `CacheEntryNotReadyError` rather than being treated as a miss with
   fallback content.
2. Validates metadata completeness — `storageKey`, `contentHash`,
   `contentEncoding`, `contentBytes`, and a valid `generation` must all be
   present and well-formed; a malformed row fails closed as a
   `malformed_metadata` integrity error rather than being served.
3. Parses the row's `storageKey` with `parseCacheObjectKey()` and cross-checks
   it against the row's own `cacheKeyHash`/`generation`/`contentHash`/`contentEncoding`
   via `assertCacheObjectKeyMatches()` — this is what makes "a stale
   generation cannot address the active generation's object" a property
   that's re-verified on every read, not just assumed from the write
   path.
4. Fetches exactly that storage key from the object store; a missing
   object is a `missing_object` integrity error.
5. Enforces `maxStoredObjectBytes` on the fetched object before
   decompressing.
6. Decompresses using the row's `contentEncoding`, bounded by
   `maxDecompressedReadBytes`; corrupt data or an oversized result become
   `corrupt_data`/`size_limit_exceeded` integrity errors.
7. Recomputes `sha256` over the decompressed UTF-8 bytes and compares
   against `entry.contentHash` with a constant-time comparison; a
   mismatch is a `hash_mismatch` integrity error.

Only after all of the above succeed does `readReadyHtml` return the HTML.
Every failure mode above raises a typed `CacheIntegrityError` with a
fixed, safe message — never the HTML body, the URL, the storage key, or
a raw provider error. Corrupted or tampered stored HTML is never silently
served.

## Sensitive URL handling

The normalized URL is allowed to exist in exactly one place: the
`cache_entries.normalized_url` database column (by documented design — it
is needed there to support future cache lookups and administration). It
must never appear in:

- structured logs
- Prometheus metric labels
- audit event metadata
- thrown error messages or stack traces
- cache storage keys
- CI output

Instead, observability code should use a `cacheKeyHash`/`normalizedUrlHash`
prefix, or the post-authorization org/project/domain IDs. This is
exercised directly by a sentinel test
(`test/db/cache-repository.test.ts`,
`test/cache-identity.test.ts`,
`test/cache-storage-service.test.ts`,
`test/db/cache-storage-service.test.ts`) using
`https://example.test/account?token=TOP_SECRET_CACHE_SENTINEL` — the test
asserts the sentinel never appears in any thrown error's message or stack,
in computed key material, in the storage key, on disk in the filesystem
adapter's path, or in metric/log-facing repository or service output,
while confirming the DB row itself does contain it (the one documented
exception). A parallel HTML sentinel
(`SENTINEL_HTML_BODY_MARKER`, embedded in a rendered page body) is
exercised the same way — it may exist only inside the private stored
object and the service's returned `readReadyHtml` result, never in a log
line or thrown error.

## Invalidation

`invalidateEntry(...)` (in the cache storage service) only ever changes
`cache_entries.status` to `invalidated` and sets `invalidated_at` — it
does **not** synchronously delete the HTML object the entry previously
referenced. Deleting on invalidation would risk deleting an object a
concurrent reader is still mid-read against; garbage-collecting
unreferenced objects is left to a future checkpoint's scheduled job. An
internal `deleteObjectForTesting(storageKey)` method exists on the
service purely for tests and as a hook a future GC job can call — there
is no public HTTP delete route in this checkpoint. `classifyCacheState`
(Phase 8A-1) and `readReadyHtml`'s `entry.status === 'ready'` check both
guarantee an invalidated entry is never served as ready.

## Metrics and logging

[`src/lib/metrics.ts`](src/lib/metrics.ts) adds, following the codebase's
existing fixed-label-enum pattern:

- `prerender_cache_operations_total{operation,result}` —
  `operation` ∈ `create_pending | update_ready | update_failed |
  invalidate | find_by_identity`; `result` ∈ `success | failure | conflict`
- `prerender_cache_repository_duration_seconds{operation}`

No hit/miss metric was added — `/v1/render` is not cache-aware yet, so
there is nothing to measure a hit or miss against.
`prerender_cache_entries_total{status}` (a status-count gauge) was **not**
added in this checkpoint since it isn't yet safely maintainable (would
require an accurate, race-free count query design deferred to when the
cache is actually populated by real traffic). Metric label sets are fixed
enums only — never a URL, hostname, cache key, org/project/domain id, or
request id. A failure inside the metrics client is caught and dropped; it
can never fail a repository operation (`safe()` wrapper, matching every
other metric in this file).

The metadata-repository layer itself still does not log per-row events
(unchanged from Phase 8A-1, deliberately, to avoid noise ahead of real
traffic). The new object-storage layer, via
[`src/lib/cache-object-events.ts`](src/lib/cache-object-events.ts), *does*
now log — but success events go at `debug` level (so they're off by
default in production log levels) and only failure/integrity/cleanup
events go at `warn`, matching the "avoid noisy success logs" instruction.
Event names: `cache.object.write.success`/`.failure`,
`cache.object.read.success`/`.failure`, `cache.object.integrity_failure`,
`cache.object.cleanup.failure`, `cache.metadata.ready`,
`cache.metadata.failed`. Allowed fields on every event: `event`,
`operation`, `result`, `errorCode`, `contentEncoding`, `contentBytes`, a
`cacheKeyHash` **prefix** (first 8 hex characters — never the full hash,
and short enough to not function as a practical lookup key),
`generation`, and post-scope `organizationId`/`projectId`/`domainId`.
Never logged: the HTML body, the normalized/raw URL, the query string,
the **full** storage key, any filesystem path, provider credentials, an
API key, a cookie, a request header, or a request body.

New Prometheus metrics
(also [`src/lib/metrics.ts`](src/lib/metrics.ts)):

- `prerender_cache_object_operations_total{operation,result}` —
  `operation` ∈ `write | read | delete | cleanup`; `result` ∈
  `success | failure`
- `prerender_cache_object_bytes{direction,encoding}` — a byte-size
  histogram; `direction` ∈ `write | read`; `encoding` ∈ `br | gzip | identity`
- `prerender_cache_integrity_failures_total{reason}` — `reason` ∈
  `missing_object | corrupt_data | hash_mismatch | size_limit_exceeded |
  encoding_mismatch | malformed_metadata`
- `prerender_cache_object_operation_duration_seconds{operation}`

No cache hit/miss metric was added — `/v1/render` still does not consult
the cache. All label sets are fixed enums, never a URL, hostname, org/
project/domain id, cache key, storage key, filesystem path, or request
id. Every metrics call is wrapped so a metrics-client failure can never
break a storage or metadata operation, matching every other metric in
this file.

## Explicitly out of scope for this checkpoint

None of the following exist yet:

- `/v1/render` does not consult or populate the cache in any way.
- Cached HTML is never returned to a client.
- No stale-while-revalidate execution.
- No Redis or BullMQ.
- No scheduled/background crawling.
- No cache management or invalidation HTTP routes.
- No deploy webhooks.
- No distributed lock / duplicate-render suppression (Phase 8C).
- No retention or garbage-collection job for old/expired rows or
  unreferenced objects (an internal cleanup hook exists for tests and a
  future GC job to call; there is no scheduler yet).
- No S3/R2 (or any other cloud object storage) adapter — only the
  in-memory and local-filesystem adapters exist.
- No frontend or dashboard work.
- No frontend or dashboard work.
