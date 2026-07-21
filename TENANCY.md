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

Deleting an organization cascades to its projects (`ON DELETE CASCADE`) —
by explicit design, not an accident; there is currently no "soft-delete an
organization" path, only "delete an organization deletes its tenant data."

## Not yet implemented (tracked for a later milestone)

- Ownership transfer.
- Member removal / role-change HTTP endpoints (the permission exists in the
  matrix; no route calls it yet).
- A tenant-scoped "fetch a specific sitemap source" endpoint (the old
  unscoped `POST /v1/sitemap-sources/:sourceId/fetch` is 410; only
  domain-level discovery is available under organization scope so far).
- Project-scoped render API keys (Milestone 3) — render authorization still
  uses the transitional global `RENDER_API_KEY`.
- Full CSRF/CORS adversarial test matrix (only the minimum Origin check is
  tested this milestone).
- Audit log (Milestone 3).
