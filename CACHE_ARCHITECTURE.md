# Cache Architecture (Phase 8A-1: identity and metadata foundation)

This document covers the cache **metadata model** established in Phase 8A-1
only. It does not describe a working cache — nothing in this checkpoint
serves cached HTML, writes bytes to any storage backend, or is called from
`/v1/render`. See "Explicitly out of scope" below.

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

## Storage key format (not yet used to write anything)

[`src/lib/cache-storage-key.ts`](src/lib/cache-storage-key.ts) defines a
pure function:

```
cache/v1/{organizationId}/{projectId}/{domainId}/{prefix}/{cacheKeyHash}.html[.br|.gz]
```

`prefix` is the first two hex characters of `cacheKeyHash`. The function
takes **only** server-generated UUIDs and a validated 64-character hex
hash — never the raw URL, hostname, path, or query string. Every ID
segment is checked against `^[A-Za-z0-9_-]{1,64}$`, so `.` and `/` (and
therefore `../` traversal) cannot appear in any input; this makes
traversal structurally impossible rather than merely discouraged by a
substring check. This function does not bind to any object-storage SDK
type and does not write anything — nothing in this checkpoint performs an
actual storage write or read.

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
`test/cache-identity.test.ts`) using
`https://example.test/account?token=TOP_SECRET_CACHE_SENTINEL` — the test
asserts the sentinel never appears in any thrown error's message or stack,
in computed key material, or in metric/log-facing repository output,
while confirming the DB row itself does contain it (the one documented
exception).

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

Structured logging event names are reserved (`cache.metadata.created` /
`.updated` / `.invalidated` / `.failed`) for the service layer that will
call this repository — this checkpoint's repository layer does not yet
log per-row events (deliberately, to avoid noisy per-row logging ahead of
real usage), but any future logging at this layer must stick to the same
field allowlist as elsewhere: event name, result, operation, status,
error code, a `cacheKeyHash`/`normalizedUrlHash` **prefix**, and
post-scope org/project/domain IDs — never the normalized URL, raw URL,
query string, storage credentials, HTML, request body, API key, or
cookie.

## Explicitly out of scope for this checkpoint

None of the following exist yet:

- `/v1/render` does not consult or populate the cache in any way.
- No object storage (local disk, S3, R2, or otherwise) is written to or
  read from — `cache-storage-key.ts` only computes what a key *would* be.
- No stale-while-revalidate execution.
- No Redis or BullMQ.
- No scheduled/background crawling.
- No cache management or invalidation HTTP routes.
- No distributed lock / duplicate-render suppression (Phase 8C).
- No retention or garbage-collection job for old/expired rows.
- No frontend or dashboard work.
