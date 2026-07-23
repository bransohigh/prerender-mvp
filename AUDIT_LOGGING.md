# Audit Logging

Checkpoint 3C (split into 3C-1/3C-2/3C-3) added a tenant-scoped audit
history table, distinct from — and never mixed with — platform-level
security event logging. This document is the source of truth for what is
audited, how, and what is deliberately out of scope for now.

## Tenant audit history vs. platform security events

Two separate mechanisms, on purpose:

| | Tenant audit history | Platform security events |
|---|---|---|
| Storage | `audit_events` table (Postgres) | Structured logs + Prometheus metrics only |
| Requires | A real `organizationId` | Nothing — can happen before any org is known |
| Examples | `project.created`, `api_key.revoked`, `organization.member.removed` | `auth.login.success`, `auth.login.failure`, `auth.logout` |
| Read access | `GET /v1/organizations/:organizationId/audit-events` (owner/admin) | Not queryable via the API — log/metrics pipeline only |

A login attempt has no organization yet — a user may belong to zero or
many organizations at the moment they submit credentials — so
`auth.login.*`/`auth.logout` are never written to `audit_events`, even
though those action names are declared in the `audit_action` Postgres enum
for forward-compatibility. See `src/lib/security-events.ts` for the
platform-event path and `src/lib/audit-events.ts` for the tenant-audit
types (`TenantAuditAction` excludes the `auth.*` actions at the type
level, not just by convention).

## Audited tenant actions

**Authentication/session**: not tenant-audited (see above) — platform
security events only.

**Invitations & membership**: `organization.invitation.created`,
`organization.invitation.cancelled`, `organization.invitation.accepted`,
`organization.member.role_changed`, `organization.member.removed`.

**Projects**: `project.created`, `project.updated`, `project.deleted`.

**Domains**: `domain.created`, `domain.verification.attempted`,
`domain.verification.succeeded`, `domain.verification.failed`,
`domain.verification_token.rotated`.

**Sitemaps**: `sitemap.discovery.started`, `.completed`, `.failed`,
`sitemap.fetch.started`, `.completed`, `.failed`.

**API keys**: `api_key.created`, `api_key.rotated`, `api_key.revoked`.

**Render authorization**: `render.authorization_rejected` is declared for
a future checkpoint (Checkpoint 3C-3) — not yet wired. Successful renders
are intentionally never audited; metrics and structured logs already
cover render volume, and a per-render audit row would be excessive
write volume for no additional security value.

## Transactional vs. best-effort audit behavior

**Transactional (mutation + audit row commit together, or neither
does)**: API key create/rotate/revoke, invitation create/cancel/accept,
member role-change/removal, project create/update/delete, domain
create/rotate-token, the final verified/failed state persisted by domain
verification, and the final state persisted by sitemap discovery/fetch
(see the two-stage section below — the *final* write in both cases is
fully atomic with its audit event, not best-effort). Each of these calls
`src/repositories/postgres/audit-repository.ts`'s `insertAuditEventRow()`
**inside the same `db.transaction()`** as the mutation itself — if the
audit insert throws (e.g. a metadata-allowlist violation, or a forced FK
violation in a test), Postgres rolls back the entire transaction and the
mutation never happened either. Proven in `test/db/audit-events.test.ts`,
`test/db/audit-events-endpoint.test.ts`, and
`test/db/audit-durability.test.ts` with tests that force the audit insert
to fail and assert no mutation row was left behind.

**Two-stage (network operation outside any transaction, final state
atomic with its audit event)**: domain verification and sitemap
discovery/fetch involve outbound DNS/HTTP calls that must never happen
while a database transaction is held open. The pattern:

1. Write a short, standalone `*.attempted` / `*.started` audit event
   (a single-row insert, not wrapped around the network call).
2. If that write itself fails, do not start the network operation.
3. Perform the DNS/HTTP/XML fetch, decompression, and parsing entirely
   outside any transaction, into a bounded, validated in-memory result —
   see `scanForSitemapCandidates()` (`src/services/sitemap-discovery-service.ts`)
   and `buildSitemapFetchTree()` (`src/services/sitemap-fetch-service.ts`),
   neither of which touches the database at all.
4. Persist the final state and the `*.succeeded`/`*.completed` (or
   `*.failed`) audit event **together, in one new transaction**:
   - Domain verification: `markVerificationAttemptForOrganization`
     (`src/repositories/postgres/tenant-repository.ts`).
   - Sitemap discovery: `persistSitemapDiscovery` — upserts every
     discovered source and the `sitemap.discovery.completed` event
     together (`src/repositories/postgres/sitemap-persistence-repository.ts`).
   - Sitemap fetch: `persistSitemapFetch` — recursively persists every
     nested sitemap source's final status, every discovered URL, and the
     top-level source's own status, together with ONE
     `sitemap.fetch.completed`/`failed` event for the whole operation
     (same file). A fetch that fails at the network stage itself (before
     any tree exists) uses `persistSitemapFetchFailure` — the source's
     `failed` status and the `sitemap.fetch.failed` event still commit
     together, in one transaction.

If the final transaction's audit insert fails in any of these: every
discovered-source upsert, every discovered-URL upsert, and the final
status/count update in that same transaction roll back with it — the API
call fails, and the client is never told the operation succeeded. The
`started`/`attempted` event from step 1 is the only thing that can remain
in that case (it already committed, in its own earlier transaction) —
representing the fact that an operation was genuinely attempted, per the
spec's explicit allowance for this. See
`test/db/audit-durability.test.ts` for the forced-failure proof (source
upserts roll back, discovered-URL upserts roll back, the source's final
status update rolls back, no completed audit row remains, and the earlier
started event is left as-is).

Sitemap discovery/fetch's *network* phase respects every pre-existing
limit unchanged: max discovered sources, max response bytes,
decompressed-byte cap, max URLs per sitemap, per-domain URL total,
recursion depth, and max nested sitemaps per index.

**Best-effort (auth, never tenant-audited)**: `auth.login.success/failure`
and `auth.logout` are structured-log + metrics only, with no transaction
at all — see `src/lib/security-events.ts`. They never block or roll back
the login flow.

## Actor consistency

Every write goes through `src/lib/audit-events.ts`'s `resolveActorFields()`
(write path) which accepts exactly one of:

- `{ type: 'user', userId }` → `actorUserId` set, `actorApiKeyId` null.
- `{ type: 'api_key', apiKeyId }` → `actorApiKeyId` set, `actorUserId` null.
- `{ type: 'system' }` → both null.

All actions wired in Checkpoints 3C-1/3C-2 use a `user` actor — every
audited mutation currently requires a Better Auth session, so
`actorUserId` is always the authenticated `ctx.userId`. No action wired so
far is actorless or attributed to a project API key; those would be
introduced together with `render.authorization_rejected` in a later
checkpoint. On the **read** path, `deriveActorType()` re-validates the
stored row and throws `AuditActorConsistencyError` if a row somehow has
both ids set (impossible via the write path, but checked anyway — such a
row is logged and excluded from the audit-events response rather than
silently misattributed).

## Metadata allowlist

`src/lib/audit-events.ts`'s `buildAuditMetadata()` accepts **only** these
keys, each a bounded string/number/boolean/null (max 500 chars):
`roleBefore`, `roleAfter`, `verificationMethod`, `discoveredCount`,
`sitemapType`, `apiKeyName`, `apiKeyPrefix`, `projectStatusBefore`,
`projectStatusAfter`, `organizationStatusBefore`,
`organizationStatusAfter`, `reasonCode`, `safeOrigin`. Any other key, or
any non-primitive value, throws — this fails a request loudly rather than
silently storing something unsafe. **Never** allowlisted (and therefore
impossible to store): password, session cookie/token, API key
plaintext/hash, invitation token/hash, verification token/hash, DNS TXT
value, full render/sitemap URL, URL path/query string, HTML/XML body,
database connection string, proxy credentials, request headers/body.

On **read**, `sanitizeStoredMetadata()` re-filters the stored JSON through
the same allowlist — but never throws; a malformed or legacy value is
dropped silently (never passed through raw) so one bad row can't break
the whole audit-events response for every other row.

## Endpoint: `GET /v1/organizations/:organizationId/audit-events`

- **Auth**: Better Auth browser session only — never a project render API
  key, never the legacy global admin key (removed entirely, see
  AUTHENTICATION.md), never `organizationId` trusted from anything but a
  fresh membership lookup against the current database state.
- **Access**: owner and admin (`audit.read` permission) — member gets 403
  `FORBIDDEN_ROLE`; a user outside the organization gets 404
  `ORGANIZATION_NOT_FOUND` (same cross-tenant-hiding behavior as every
  other organization-scoped route).
- **Pagination**: cursor-based, `createdAt DESC, id DESC` — no offset
  fallback. The cursor is an opaque base64url token encoding only
  `(createdAt, id)`; a malformed token returns a stable 400
  `invalid_cursor`. `limit` is bounded 1–100, default 20.
- **Filters**: `action` (fixed `audit_action` enum), `result`
  (`success`/`failure`), `targetType` (fixed list:
  `api_key`/`invitation`/`member`/`project`/`domain`/`sitemap_source`). An
  unknown value for any filter returns 400. No free-text search, no JSON
  metadata queries, no arbitrary sort fields.
- **Response fields**: `id`, `action`, `result`, `actorType`,
  `actorUserId`, `actorApiKeyId`, `targetType`, `targetId`, `errorCode`,
  `requestId`, `metadata` (allowlist-filtered), `createdAt`. Never
  database-internal fields, Better Auth objects, tokens, hashes, cookies,
  or full URLs.

## Structured logging

Stable event names, fields, and prohibitions are documented inline in
`src/lib/security-events.ts` (platform auth events) and
`src/routes/organizations.ts`'s audit-events handler
(`audit.read.success`/`audit.read.denied`). Never logged: raw audit
metadata objects, tokens, hashes, cookies, passwords, emails, full URLs,
query strings, request bodies, HTML/XML. Pino's redact list
(`src/app.ts`) remains defense in depth, not the only protection — every
call site is written to never pass those values to the logger in the
first place.

## Metrics

`prerender_audit_events_total{action,result}` represents **committed
audit rows only** — the increment happens strictly after the surrounding
transaction has resolved, never from inside `insertAuditEventRow()`
itself (that function is a pure insert with no metrics side effect at
all). Two call sites own this timing:

- `src/repositories/postgres/audit-repository.ts`'s
  `runAuditedTransaction()` wraps every "mutation + audit in one
  `db.transaction()`" call site (project/domain/api-key/invitation/
  member/sitemap-persistence). It only increments `success` after
  `db.transaction()` has resolved, and only increments `failure` (at most
  once) if an audit insert was actually attempted before the rollback —
  tracked via a `setAuditedAction()` callback invoked from inside the
  transaction right before the insert, so a business-validation failure
  that never reaches the audit insert (e.g. a slug conflict) increments
  nothing at all.
- `createPostgresAuditRepository()`'s `createAuditEvent()` (the
  standalone-write path used by `AuditService.record()`) increments after
  its single insert statement resolves — for a lone `INSERT`, "resolved"
  already means "committed".

Labels are the fixed `audit_action`/`audit_result` enum values only —
never an id, hostname, URL, or request id. A metrics-client error is
caught and dropped at both call sites above — it can never mask a real
mutation error, never "un-succeed" an already-committed operation for the
caller, and never itself cause a rollback. See
`test/db/audit-durability.test.ts` for tests proving: a committed write
increments success exactly once; a rollback after the audit insert was
attempted increments failure at most once; a rollback that never reached
the audit insert increments nothing; API key rotation (which touches two
rows in one transaction) produces exactly one `api_key.rotated` metric
call, not two; and a throwing metrics client never breaks or masks an
already-committed mutation.

## Known gaps / not yet implemented

- No automated retention or archival — `audit_events` grows unbounded.
- No SIEM/external export.
- No audit-record deletion endpoint — audit rows are not user-editable or
  deletable through the API by design.
- `render.authorization_rejected` is declared but not yet wired
  (Checkpoint 3C-3).
- The full adversarial CSRF/CORS test matrix and the Docker hardened-smoke
  extension covering audit flows remain Checkpoint 3C-3.
