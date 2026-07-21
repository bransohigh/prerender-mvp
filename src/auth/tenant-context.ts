import type { FastifyRequest } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { AppError } from '../lib/app-error.js';
import { member as memberTable } from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Auth } from './auth.js';
import { requireSession, type SessionContext } from './session.js';
import { roleHasPermission, type OrganizationRole, type OrganizationPermission } from './permissions.js';
import { createNoopMetrics, type Metrics } from '../lib/metrics.js';

export { requireSession } from './session.js';
export type { SessionContext } from './session.js';

export interface TenantContext extends SessionContext {
  organizationId: string;
  role: OrganizationRole;
}

// Membership is read from the database on every call — never cached in the
// session cookie — so a role change or removal takes effect on the very
// next request, per the "no stale privilege in cookie cache" requirement.
export async function requireOrganizationMembership(
  request: FastifyRequest,
  auth: Auth,
  db: Database,
  organizationId: string,
  metrics: Metrics = createNoopMetrics(),
): Promise<TenantContext> {
  let session: SessionContext;
  try {
    session = await requireSession(request, auth);
  } catch (err) {
    metrics.incrementAuthorizationDenial('unauthenticated');
    throw err;
  }

  const membership = await db.query.member.findFirst({
    where: and(eq(memberTable.organizationId, organizationId), eq(memberTable.userId, session.userId)),
  });

  // A caller who is not a member of this organization must get exactly the
  // same 404 as a caller asking about an organization that doesn't exist
  // at all — the response must not distinguish the two cases.
  if (!membership) {
    metrics.incrementAuthorizationDenial('not_member');
    throw new AppError('ORGANIZATION_NOT_FOUND', 'Organization not found');
  }

  return {
    ...session,
    organizationId,
    role: membership.role as OrganizationRole,
  };
}

export async function requireOrganizationRole(
  request: FastifyRequest,
  auth: Auth,
  db: Database,
  organizationId: string,
  allowedRoles: OrganizationRole[],
  metrics: Metrics = createNoopMetrics(),
): Promise<TenantContext> {
  const ctx = await requireOrganizationMembership(request, auth, db, organizationId, metrics);
  if (!allowedRoles.includes(ctx.role)) {
    // The caller IS a confirmed member here, so insufficient role is a 403
    // (not a 404) — this is the one case where role, not existence, is the
    // reason for denial.
    metrics.incrementAuthorizationDenial('insufficient_role');
    throw new AppError('FORBIDDEN_ROLE', 'Insufficient role for this operation');
  }
  return ctx;
}

export async function requireOrganizationPermission(
  request: FastifyRequest,
  auth: Auth,
  db: Database,
  organizationId: string,
  permission: OrganizationPermission,
  metrics: Metrics = createNoopMetrics(),
): Promise<TenantContext> {
  const ctx = await requireOrganizationMembership(request, auth, db, organizationId, metrics);
  if (!roleHasPermission(ctx.role, permission)) {
    metrics.incrementAuthorizationDenial('insufficient_role');
    throw new AppError('FORBIDDEN_ROLE', `Role '${ctx.role}' lacks permission '${permission}'`);
  }
  return ctx;
}
