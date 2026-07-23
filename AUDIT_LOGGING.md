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
create/rotate-token, and the final verified/failed state persisted by
domain verification. Each of these calls
`src/repositories/postgres/audit-repository.ts`'s `insertAuditEventRow()`
**inside the same `db.transaction()`** as the mutation itself — if the
audit insert throws (e.g. a metadata-allowlist violation, or a forced FK
violation in a test), Postgres rolls back the entire transaction and the
mutation never happened either. Proven in `test/db/audit-events.test.ts`
and `test/db/audit-events-endpoint.test.ts` with tests that force the
audit insert to fail and assert no mutation row was left behind.

**Two-stage (network operation outside any transaction)**: domain
verification and sitemap discovery/fetch involve outbound DNS/HTTP calls
that must never happen while a database transaction is held open. The
pattern:

1. Write a short, standalone `*.attempted` / `*.started` audit event
   (a single-row insert, not wrapped around the network call).
2. If that write itself fails, do not start the network operation.
3. Perform the DNS/HTTP/XML work with no open transaction.
4. Persist the final state and the `*.succeeded`/`*.completed` (or
   `*.failed`) audit event **together, in one new transaction** — for
   domain verification this is fully atomic (see
   `markVerificationAttemptForOrganization` in
   `src/repositories/postgres/tenant-repository.ts`).

**Documented limitation — sitemap discovery/fetch**: unlike domain
verification (a single final mutation), sitemap discovery upserts each
discovered source as it's found, and sitemap fetch can recurse into
nested sitemap indexes with per-source `recordFetchResult` calls. Making
every one of those writes atomic with one final audit row would require
restructuring already-tested recursive fetch logic. For this checkpoint,
`sitemap.discovery.*` and `sitemap.fetch.*` audit events are recorded as
their own short writes around the network-heavy call (via
`AuditService.record()` in the route handlers,
`src/routes/organizations.ts`) — best-effort relative to the underlying
per-source database writes, not one atomic transaction covering all of
them. This is a deliberate, narrower guarantee than the fully atomic
mutations above, not an oversight.

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

`prerender_audit_events_total{action,result}` — incremented inside
`insertAuditEventRow()` itself, so every write path (transactional or
standalone) is covered uniformly. Labels are the fixed `audit_action`/
`audit_result` enum values only — never an id, hostname, URL, or request
id. A metrics-increment failure is swallowed (see `src/lib/metrics.ts`'s
`safe()`) and never affects the underlying transaction; conversely, an
audit database failure on a transactionally-required mutation still rolls
back that mutation regardless of whether the metrics increment itself
succeeded — metrics reliability and audit durability are deliberately
independent guarantees.

## Known gaps / not yet implemented

- No automated retention or archival — `audit_events` grows unbounded.
- No SIEM/external export.
- No audit-record deletion endpoint — audit rows are not user-editable or
  deletable through the API by design.
- `render.authorization_rejected` is declared but not yet wired
  (Checkpoint 3C-3).
- The full adversarial CSRF/CORS test matrix and the Docker hardened-smoke
  extension covering audit flows remain Checkpoint 3C-3.
