# Tenancy

## Tenant boundary

A Better Auth **organization** is the tenant boundary. Every `projects` row
has a required `organizationId` (FK to `organization.id`, `ON DELETE
CASCADE`). Domains, sitemap sources, and discovered URLs are tenant-bound
transitively through `project -> organization`.

## Roles

`owner`, `admin`, `member` — Better Auth's own default organization roles.
The full permission matrix lives in `src/auth/permissions.ts` (single
source of truth, unit-testable in isolation):

| Permission | owner | admin | member |
|---|---|---|---|
| organization.read | ✓ | ✓ | ✓ |
| organization.update / delete | ✓ | – | – |
| member.list | ✓ | ✓ | ✓ |
| member.role.change / member.remove | ✓ | – | – |
| invitation.create.member / .admin | ✓ | ✓ | – |
| invitation.list / cancel | ✓ | ✓ | – |
| project.create / update / delete | ✓ | ✓ | – |
| project.read | ✓ | ✓ | ✓ |
| domain.create / update / verify / rotate_token | ✓ | ✓ | – |
| domain.read | ✓ | ✓ | ✓ |
| sitemap.discover / fetch | ✓ | ✓ | – |
| sitemap.read | ✓ | ✓ | ✓ |

Owner role can never be granted through an invitation — the `role` field on
`POST /v1/organizations/:organizationId/invitations` only accepts
`admin`/`member`. Ownership transfer is not implemented in this phase.

## Authorization layers

Enforced at three independent layers, never just one:

1. **Route**: every organization-scoped handler calls
   `requireOrganizationPermission()` / `requireOrganizationRole()`
   (`src/auth/tenant-context.ts`) before touching any resource.
2. **Service**: `src/services/project-service.ts` /
   `domain-service.ts` are reused unchanged for tenant routes via
   `src/repositories/postgres/tenant-scoped-adapters.ts`, which binds them
   to a specific `organizationId`.
3. **Repository/SQL**: `src/repositories/postgres/tenant-repository.ts`
   puts `organizationId` (or a JOIN up to it) directly in every WHERE
   clause — the scoping cannot be forgotten by a caller, because there is
   no unscoped method to call by mistake from a tenant route.

Membership/role is read from the database on every request — never cached
in the session cookie — so a role change or membership removal takes effect
on the very next request.

## Cross-tenant behavior

- Resource outside the caller's tenant (or organization the caller isn't a
  member of) → **404**, using the same error code (`ORGANIZATION_NOT_FOUND`,
  `PROJECT_NOT_FOUND`, `DOMAIN_NOT_FOUND`, `INVITATION_NOT_FOUND`) regardless
  of whether the resource exists in another org or doesn't exist at all.
- Confirmed member, insufficient role → **403** (`FORBIDDEN_ROLE`).
- No response ever includes the other organization's id, name, or any of
  its data.

## organizationId migration procedure

Three-stage expand/backfill/contract, matching what a real installation
with existing data must go through:

1. `drizzle/0001_add_better_auth_tables.sql` — adds `projects.organization_id`
   as **nullable** (expand phase; existing rows untouched).
2. `npm run tenancy:backfill-projects -- --organization-id <uuid> [--dry-run]`
   — assigns every orphan (`organization_id IS NULL`) project to one
   explicitly named, already-existing organization. Validates the id
   format, requires the target organization to exist, runs in a
   transaction, reports the affected row count, and is idempotent (a
   second run reports 0 affected rows and does not error).
3. `drizzle/0002_projects_organization_id_not_null.sql` — adds the `NOT
   NULL` constraint (contract phase). **Fails loudly** (Postgres rejects
   the `ALTER TABLE ... SET NOT NULL`) if any orphan row still exists —
   this is native Postgres behavior, not app-level logic, so it can't be
   silently bypassed.

Fresh installs: `npm run db:migrate` applies all three migrations
back-to-back against an empty table, so step 2 is a no-op (0 rows) and step
3 succeeds immediately. `npm run auth:bootstrap-owner` should still run
first so there's an organization for any subsequently created project to
attach to.

`drizzle/0003_projects_organization_restrict_delete.sql` changes
`projects.organization_id`'s foreign key from `ON DELETE CASCADE` to `ON
DELETE RESTRICT`: deleting an organization that still has any projects
**fails** (Postgres FK violation) rather than silently cascading away
projects, and transitively, their domains/sitemap sources/discovered URLs.
**Organization deletion itself is not implemented** — there is no route or
service that deletes an organization; the FK behavior only defines what
happens if something deletes the row directly (e.g. a future admin tool or
manual operation), and it must never destroy tenant data as a side effect.

## Member management (owner-only, conservative Milestone 2 policy)

`PATCH /v1/organizations/:organizationId/members/:memberId` (`{"role": "admin"|"member"}`)
and `DELETE /v1/organizations/:organizationId/members/:memberId` — both
**owner-only** (admin cannot change roles or remove members this
milestone). Owner membership itself can never be changed or removed by
anyone, including that owner — this blanket rule also covers "the final
owner can't be removed" and "an owner can't demote themselves" without
needing separate self/last-owner special cases. Cross-tenant member ids →
404. `:memberId` is the `member.id` row id, never a Better Auth user id
directly.

## Tenant-scoped sitemap source fetch

`POST /v1/organizations/:organizationId/sitemap-sources/:sourceId/fetch`
and `GET /v1/organizations/:organizationId/sitemap-sources/:sourceId`
replace the old unscoped `POST /v1/sitemap-sources/:sourceId/fetch` (now
410). Source lookup is organization-scoped in SQL
(`getSitemapSourceForOrganization`, a JOIN through `domains -> projects`).
Owner/admin may fetch; member may read (`GET`) but not fetch (`POST`).
Reuses the existing `fetchAndParseSitemapSource` (gzip/XXE/redirect/size
limits, proxy routing, off-domain URL rejection all unchanged).

## Project-scoped render API keys and organization status (Checkpoint 3B)

Render authorization is now fully tenant-scoped: a render API key carries
`organizationId` + `projectId`, and every render request re-checks
organization status, project status/scope, and domain scope+status before
touching Chromium. See AUTHENTICATION.md and SECURITY.md for the exact key
model and authorization sequence.

`organization.status` (`active`/`suspended`) is an application-level column
added directly to the `organization` table (`drizzle/0004_organization_status.sql`)
— Better Auth's own schema has no status/suspension concept. Existing rows
backfill to `active` via the column default; the column is `NOT NULL`.
There is no suspend/unsuspend management endpoint in this checkpoint (out
of scope per the checkpoint instructions) — only the repository/schema
support and test fixtures exist so render authorization can enforce it.

## Tenant audit history (Checkpoint 3C)

`GET /v1/organizations/:organizationId/audit-events` (owner/admin only,
cursor-paginated) exposes the organization's audit history — project,
domain, sitemap, API key, invitation, and membership mutations. See
[AUDIT_LOGGING.md](AUDIT_LOGGING.md) for the full action list, the
metadata allowlist, transactional-vs-two-stage write guarantees, and the
distinction between this tenant history and platform-level
`auth.login.*`/`auth.logout` security events (which are never tenant
audit rows).

## Route security-class separation (Checkpoint 3C-3)

Three distinct classes, never conflated:

1. **Better Auth's own mount** (`/api/auth/*`) — Better Auth's own Origin
   handling is preserved as-is; the Fastify bridge (`src/auth/plugin.ts`)
   forwards the real client `Origin`/`Host`/all headers through
   unmodified, and no second, conflicting Origin policy is applied on top
   of it.
2. **Cookie-authenticated management** (`/v1/organizations/*`) — the
   centralized Origin-exact-match CSRF hook (SECURITY.md) applies to
   every mutating request.
3. **Project render API** (`POST /v1/render`) — authenticated only by
   `x-render-api-key`; never subject to the CSRF Origin hook (it isn't
   cookie-authenticated) and never browser-callable via CORS (see
   AUTHENTICATION.md).

## Not yet implemented (tracked for a later checkpoint)

- Ownership transfer.
- Organization suspend/unsuspend management endpoint.
- Full CSRF/CORS adversarial test matrix (only the minimum Origin check is
  tested; Checkpoint 3C covers the full matrix).
- Audit log (Checkpoint 3C).
