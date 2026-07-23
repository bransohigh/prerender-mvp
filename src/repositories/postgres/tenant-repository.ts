import { and, asc, eq, gt, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  projects,
  domains,
  sitemapSources,
  discoveredUrls,
  member as memberTable,
  invitations,
  user as userTable,
  organization as organizationTable,
} from '../../db/schema.js';
import { AppError } from '../../lib/app-error.js';
import { insertAuditEventRow, runAuditedTransaction } from './audit-repository.js';
import { buildAuditMetadata } from '../../lib/audit-events.js';
import { createNoopMetrics, type Metrics } from '../../lib/metrics.js';
import type {
  Project,
  Domain,
  SitemapSource,
  DiscoveredUrl,
  PageResult,
  CreateProjectInput,
  UpdateProjectInput,
  VerificationMethod,
  SitemapSourceType,
  SitemapSourceStatus,
} from '../types.js';

const UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const direct = (err as { code?: string }).code;
  if (direct) return direct;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    return (cause as { code?: string }).code;
  }
  return undefined;
}

function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === UNIQUE_VIOLATION;
}

export interface MemberSummary {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: string;
  createdAt: Date;
}

export interface InvitationSummary {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  invitedByUserId: string;
}

// Every method here takes organizationId as its first argument and enforces
// it inside the SQL query (JOINs up to `projects.organization_id` for
// domain/sitemap/discovered-url resources) — never as an application-level
// filter applied after an unscoped fetch. This is what src/routes/organizations.ts
// and its helper services call; the older unscoped
// src/repositories/postgres/postgres-{project,domain,sitemap}-repository.ts
// implementations remain in use only by internal, already-tenant-checked
// call sites (e.g. domain-verification-service, sitemap-discovery-service)
// and by the transitional legacy routes/render route — never directly by a
// route handler that hasn't already established organization scope.
export function createTenantRepository(db: Database, metrics: Metrics = createNoopMetrics()) {
  async function getDomainForOrganization(organizationId: string, domainId: string): Promise<Domain | null> {
    const rows = await db
      .select({ domain: domains })
      .from(domains)
      .innerJoin(projects, eq(domains.projectId, projects.id))
      .where(and(eq(domains.id, domainId), eq(projects.organizationId, organizationId)))
      .limit(1);
    return (rows[0]?.domain as Domain) ?? null;
  }

  // Render-path lookup: requires organization AND project scope together
  // (not just organization), so a key scoped to project A can never
  // resolve a domain that belongs to project B in the same organization.
  async function getDomainForOrganizationProject(
    organizationId: string,
    projectId: string,
    domainId: string,
  ): Promise<Domain | null> {
    const rows = await db
      .select({ domain: domains })
      .from(domains)
      .innerJoin(projects, eq(domains.projectId, projects.id))
      .where(
        and(
          eq(domains.id, domainId),
          eq(domains.projectId, projectId),
          eq(projects.organizationId, organizationId),
        ),
      )
      .limit(1);
    return (rows[0]?.domain as Domain) ?? null;
  }

  async function getOrganizationStatus(organizationId: string): Promise<'active' | 'suspended' | null> {
    const row = await db.query.organization.findFirst({
      where: eq(organizationTable.id, organizationId),
      columns: { status: true },
    });
    return row?.status ?? null;
  }

  async function getSitemapSourceForOrganization(organizationId: string, sourceId: string): Promise<SitemapSource | null> {
    const rows = await db
      .select({ source: sitemapSources })
      .from(sitemapSources)
      .innerJoin(domains, eq(sitemapSources.domainId, domains.id))
      .innerJoin(projects, eq(domains.projectId, projects.id))
      .where(and(eq(sitemapSources.id, sourceId), eq(projects.organizationId, organizationId)))
      .limit(1);
    return (rows[0]?.source as SitemapSource) ?? null;
  }

  return {
    getDomainForOrganization,
    getDomainForOrganizationProject,
    getOrganizationStatus,
    getSitemapSourceForOrganization,
    // ---- projects ----------------------------------------------------
    async createProjectForOrganization(
      organizationId: string,
      input: CreateProjectInput,
      actorUserId: string,
      requestId: string | null,
    ): Promise<Project> {
      try {
        return await runAuditedTransaction(db, metrics, async (tx, setAuditedAction) => {
          const [row] = await tx
            .insert(projects)
            .values({ ...input, organizationId })
            .returning();
          const created = row as Project;
          setAuditedAction('project.created');
          await insertAuditEventRow(tx, {
            organizationId,
            actorUserId,
            actorApiKeyId: null,
            action: 'project.created',
            targetType: 'project',
            targetId: created.id,
            result: 'success',
            errorCode: null,
            requestId,
            metadata: null,
          });
          return created;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AppError('PROJECT_SLUG_CONFLICT', `Slug already in use: ${input.slug}`);
        }
        throw err;
      }
    },

    async getProjectForOrganization(organizationId: string, projectId: string): Promise<Project | null> {
      const [row] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId), ne(projects.status, 'deleted')))
        .limit(1);
      return (row as Project) ?? null;
    },

    async listProjectsForOrganization(
      organizationId: string,
      options: { limit: number; cursor?: string | null },
    ): Promise<PageResult<Project>> {
      const conditions = [eq(projects.organizationId, organizationId), ne(projects.status, 'deleted')];
      if (options.cursor) conditions.push(gt(projects.id, options.cursor));
      const rows = await db
        .select()
        .from(projects)
        .where(and(...conditions))
        .orderBy(asc(projects.id))
        .limit(options.limit + 1);
      const hasMore = rows.length > options.limit;
      const page = rows.slice(0, options.limit) as Project[];
      return { items: page, nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
    },

    async updateProjectForOrganization(
      organizationId: string,
      projectId: string,
      input: UpdateProjectInput,
      actorUserId: string,
      requestId: string | null,
    ): Promise<Project | null> {
      try {
        return await runAuditedTransaction(db, metrics, async (tx, setAuditedAction) => {
          const [before] = await tx
            .select({ status: projects.status })
            .from(projects)
            .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
            .limit(1);
          const [row] = await tx
            .update(projects)
            .set({ ...input, updatedAt: new Date() })
            .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
            .returning();
          if (!row) return null;
          const updated = row as Project;
          setAuditedAction('project.updated');
          await insertAuditEventRow(tx, {
            organizationId,
            actorUserId,
            actorApiKeyId: null,
            action: 'project.updated',
            targetType: 'project',
            targetId: projectId,
            result: 'success',
            errorCode: null,
            requestId,
            metadata: buildAuditMetadata(
              input.status
                ? { projectStatusBefore: before?.status, projectStatusAfter: updated.status }
                : {},
            ),
          });
          return updated;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AppError('PROJECT_SLUG_CONFLICT', `Slug already in use: ${input.slug}`);
        }
        throw err;
      }
    },

    async softDeleteProjectForOrganization(
      organizationId: string,
      projectId: string,
      actorUserId: string,
      requestId: string | null,
    ): Promise<Project | null> {
      return runAuditedTransaction(db, metrics, async (tx, setAuditedAction) => {
        const [before] = await tx
          .select({ status: projects.status })
          .from(projects)
          .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
          .limit(1);
        const [row] = await tx
          .update(projects)
          .set({ status: 'deleted', updatedAt: new Date() })
          .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
          .returning();
        if (!row) return null;
        const deleted = row as Project;
        setAuditedAction('project.deleted');
        await insertAuditEventRow(tx, {
          organizationId,
          actorUserId,
          actorApiKeyId: null,
          action: 'project.deleted',
          targetType: 'project',
          targetId: projectId,
          result: 'success',
          errorCode: null,
          requestId,
          metadata: buildAuditMetadata({ projectStatusBefore: before?.status, projectStatusAfter: 'deleted' }),
        });
        return deleted;
      });
    },

    // ---- domains -------------------------------------------------------
    async createDomainForOrganization(
      organizationId: string,
      projectId: string,
      input: {
        hostname: string;
        normalizedHostname: string;
        verificationMethod: VerificationMethod;
        verificationTokenHash: string;
      },
      actorUserId: string,
      requestId: string | null,
    ): Promise<Domain> {
      // Verifying the project belongs to this org happens in the same
      // transaction as the insert, so a caller cannot attach a domain to
      // another tenant's project by guessing its id.
      return runAuditedTransaction(db, metrics, async (tx, setAuditedAction) => {
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
          .limit(1);
        if (!project) {
          throw new AppError('PROJECT_NOT_FOUND', `Project not found: ${projectId}`);
        }
        try {
          const [row] = await tx
            .insert(domains)
            .values({ projectId, ...input })
            .returning();
          const created = row as Domain;
          setAuditedAction('domain.created');
          await insertAuditEventRow(tx, {
            organizationId,
            actorUserId,
            actorApiKeyId: null,
            action: 'domain.created',
            targetType: 'domain',
            targetId: created.id,
            result: 'success',
            errorCode: null,
            requestId,
            metadata: buildAuditMetadata({ verificationMethod: input.verificationMethod }),
          });
          return created;
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new AppError('DOMAIN_ALREADY_EXISTS', `Domain already registered: ${input.normalizedHostname}`);
          }
          throw err;
        }
      });
    },

    async listDomainsForOrganizationProject(
      organizationId: string,
      projectId: string,
      options: { limit: number; cursor?: string | null },
    ): Promise<PageResult<Domain>> {
      const conditions = [
        eq(domains.projectId, projectId),
        eq(projects.organizationId, organizationId),
      ];
      if (options.cursor) conditions.push(gt(domains.id, options.cursor));
      const rows = await db
        .select({ domain: domains })
        .from(domains)
        .innerJoin(projects, eq(domains.projectId, projects.id))
        .where(and(...conditions))
        .orderBy(asc(domains.id))
        .limit(options.limit + 1);
      const hasMore = rows.length > options.limit;
      const page = rows.slice(0, options.limit).map((r) => r.domain as Domain);
      return { items: page, nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
    },

    async rotateVerificationTokenForOrganization(
      organizationId: string,
      domainId: string,
      newTokenHash: string,
      actorUserId: string,
      requestId: string | null,
    ): Promise<Domain | null> {
      const existing = await getDomainForOrganization(organizationId, domainId);
      if (!existing) return null;
      const wasVerified = existing.status === 'verified';
      return runAuditedTransaction(db, metrics, async (tx, setAuditedAction) => {
        const [row] = await tx
          .update(domains)
          .set({
            verificationTokenHash: newTokenHash,
            status: wasVerified ? 'pending' : existing.status,
            verifiedAt: wasVerified ? null : existing.verifiedAt,
            updatedAt: new Date(),
          })
          .where(eq(domains.id, domainId))
          .returning();
        if (!row) return null;
        setAuditedAction('domain.verification_token.rotated');
        await insertAuditEventRow(tx, {
          organizationId,
          actorUserId,
          actorApiKeyId: null,
          action: 'domain.verification_token.rotated',
          targetType: 'domain',
          targetId: domainId,
          result: 'success',
          errorCode: null,
          requestId,
          metadata: buildAuditMetadata({ verificationMethod: existing.verificationMethod }),
        });
        return row as Domain;
      });
    },

    // Two-stage network-operation pattern (Checkpoint 3C-2): the caller
    // (src/services/domain-verification-service.ts's verifyDomainOrThrow)
    // records a domain.verification.attempted audit event via AuditService
    // BEFORE calling this — outside any transaction, since the DNS/HTTP
    // check itself happens between that write and this one. This method
    // only ever runs AFTER the network check completes, and persists the
    // final domain state + the succeeded/failed audit event together in
    // one transaction — never a transaction held open across the network
    // call itself.
    async markVerificationAttemptForOrganization(
      organizationId: string,
      domainId: string,
      result: { success: true } | { success: false; failureCode: string },
      actorUserId: string,
      requestId: string | null,
    ): Promise<Domain | null> {
      const existing = await getDomainForOrganization(organizationId, domainId);
      if (!existing) return null;
      const now = new Date();
      return runAuditedTransaction(db, metrics, async (tx, setAuditedAction) => {
        let row: typeof domains.$inferSelect | undefined;
        if (result.success) {
          [row] = await tx
            .update(domains)
            .set({ status: 'verified', verifiedAt: now, lastVerificationAttemptAt: now, verificationFailureCount: 0, updatedAt: now })
            .where(eq(domains.id, domainId))
            .returning();
        } else {
          [row] = await tx
            .update(domains)
            .set({
              status: existing.status === 'verified' ? 'verified' : 'failed',
              lastVerificationAttemptAt: now,
              verificationFailureCount: existing.verificationFailureCount + 1,
              updatedAt: now,
            })
            .where(eq(domains.id, domainId))
            .returning();
        }
        if (!row) return null;
        const action = result.success ? 'domain.verification.succeeded' : 'domain.verification.failed';
        setAuditedAction(action);
        await insertAuditEventRow(tx, {
          organizationId,
          actorUserId,
          actorApiKeyId: null,
          action,
          targetType: 'domain',
          targetId: domainId,
          result: 'success',
          errorCode: null,
          requestId,
          metadata: buildAuditMetadata({
            verificationMethod: existing.verificationMethod,
            reasonCode: result.success ? undefined : result.failureCode,
          }),
        });
        return row as Domain;
      });
    },

    // ---- sitemap sources -----------------------------------------------
    async listSitemapSourcesForOrganizationDomain(
      organizationId: string,
      domainId: string,
    ): Promise<SitemapSource[]> {
      const rows = await db
        .select({ source: sitemapSources })
        .from(sitemapSources)
        .innerJoin(domains, eq(sitemapSources.domainId, domains.id))
        .innerJoin(projects, eq(domains.projectId, projects.id))
        .where(and(eq(sitemapSources.domainId, domainId), eq(projects.organizationId, organizationId)));
      return rows.map((r) => r.source as SitemapSource);
    },

    async upsertSitemapSourceForOrganization(
      organizationId: string,
      domainId: string,
      input: { url: string; normalizedUrl: string; type: SitemapSourceType },
    ): Promise<SitemapSource> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: domains.id })
          .from(domains)
          .innerJoin(projects, eq(domains.projectId, projects.id))
          .where(and(eq(domains.id, domainId), eq(projects.organizationId, organizationId)))
          .limit(1);
        if (rows.length === 0) {
          throw new AppError('DOMAIN_NOT_FOUND', `Domain not found: ${domainId}`);
        }
        const [row] = await tx
          .insert(sitemapSources)
          .values({ domainId, url: input.url, normalizedUrl: input.normalizedUrl, type: input.type })
          .onConflictDoUpdate({
            target: [sitemapSources.domainId, sitemapSources.normalizedUrl],
            set: { updatedAt: new Date() },
          })
          .returning();
        return row as SitemapSource;
      });
    },

    async recordSitemapFetchResultForOrganization(
      organizationId: string,
      sourceId: string,
      input: {
        status: SitemapSourceStatus;
        lastHttpStatus?: number | null;
        lastErrorCode?: string | null;
        etag?: string | null;
        lastModified?: string | null;
        discoveredUrlCount?: number;
      },
    ): Promise<SitemapSource | null> {
      const existing = await getSitemapSourceForOrganization(organizationId, sourceId);
      if (!existing) return null;
      const set: Record<string, unknown> = { status: input.status, lastFetchedAt: new Date(), updatedAt: new Date() };
      if (input.lastHttpStatus !== undefined) set['lastHttpStatus'] = input.lastHttpStatus;
      if (input.lastErrorCode !== undefined) set['lastErrorCode'] = input.lastErrorCode;
      if (input.etag !== undefined) set['etag'] = input.etag;
      if (input.lastModified !== undefined) set['lastModified'] = input.lastModified;
      if (input.discoveredUrlCount !== undefined) set['discoveredUrlCount'] = input.discoveredUrlCount;
      const [row] = await db.update(sitemapSources).set(set).where(eq(sitemapSources.id, sourceId)).returning();
      return (row as SitemapSource) ?? null;
    },

    // ---- discovered urls -------------------------------------------------
    async listDiscoveredUrlsForOrganization(
      organizationId: string,
      domainId: string,
      options: { limit: number; cursor?: string | null },
    ): Promise<PageResult<DiscoveredUrl>> {
      const conditions = [eq(discoveredUrls.domainId, domainId), eq(projects.organizationId, organizationId)];
      if (options.cursor) conditions.push(gt(discoveredUrls.id, options.cursor));
      const rows = await db
        .select({ url: discoveredUrls })
        .from(discoveredUrls)
        .innerJoin(domains, eq(discoveredUrls.domainId, domains.id))
        .innerJoin(projects, eq(domains.projectId, projects.id))
        .where(and(...conditions))
        .orderBy(asc(discoveredUrls.id))
        .limit(options.limit + 1);
      const hasMore = rows.length > options.limit;
      const page = rows.slice(0, options.limit).map((r) => r.url as DiscoveredUrl);
      return { items: page, nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
    },

    // ---- members / invitations ------------------------------------------
    async listMembersForOrganization(organizationId: string): Promise<MemberSummary[]> {
      const rows = await db
        .select({
          id: memberTable.id,
          userId: memberTable.userId,
          role: memberTable.role,
          createdAt: memberTable.createdAt,
          email: userTable.email,
          name: userTable.name,
        })
        .from(memberTable)
        .innerJoin(userTable, eq(memberTable.userId, userTable.id))
        .where(eq(memberTable.organizationId, organizationId))
        .orderBy(asc(memberTable.createdAt));
      return rows;
    },

    async getMembershipForOrganization(
      organizationId: string,
      userId: string,
    ): Promise<{ id: string; role: string } | null> {
      const row = await db.query.member.findFirst({
        where: and(eq(memberTable.organizationId, organizationId), eq(memberTable.userId, userId)),
      });
      return row ? { id: row.id, role: row.role } : null;
    },

    // memberId here is member.id (the row's own primary key), matching the
    // :memberId route param — never the Better Auth user id directly, so a
    // caller can't probe user existence across organizations.
    async getMemberForOrganization(organizationId: string, memberId: string): Promise<MemberSummary | null> {
      const rows = await db
        .select({
          id: memberTable.id,
          userId: memberTable.userId,
          role: memberTable.role,
          createdAt: memberTable.createdAt,
          email: userTable.email,
          name: userTable.name,
        })
        .from(memberTable)
        .innerJoin(userTable, eq(memberTable.userId, userTable.id))
        .where(and(eq(memberTable.id, memberId), eq(memberTable.organizationId, organizationId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async updateMemberRoleForOrganization(
      organizationId: string,
      memberId: string,
      role: 'admin' | 'member',
      actorUserId: string,
      requestId: string | null,
    ): Promise<MemberSummary | null> {
      const existing = await db.query.member.findFirst({
        where: and(eq(memberTable.id, memberId), eq(memberTable.organizationId, organizationId)),
      });
      if (!existing) return null;
      const roleBefore = existing.role;
      await runAuditedTransaction(db, metrics, async (tx, setAuditedAction) => {
        await tx.update(memberTable).set({ role }).where(eq(memberTable.id, memberId));
        setAuditedAction('organization.member.role_changed');
        await insertAuditEventRow(tx, {
          organizationId,
          actorUserId,
          actorApiKeyId: null,
          action: 'organization.member.role_changed',
          targetType: 'member',
          targetId: memberId,
          result: 'success',
          errorCode: null,
          requestId,
          metadata: buildAuditMetadata({ roleBefore, roleAfter: role }),
        });
      });
      const rows = await db
        .select({
          id: memberTable.id,
          userId: memberTable.userId,
          role: memberTable.role,
          createdAt: memberTable.createdAt,
          email: userTable.email,
          name: userTable.name,
        })
        .from(memberTable)
        .innerJoin(userTable, eq(memberTable.userId, userTable.id))
        .where(eq(memberTable.id, memberId))
        .limit(1);
      return rows[0] ?? null;
    },

    async removeMemberForOrganization(
      organizationId: string,
      memberId: string,
      actorUserId: string,
      requestId: string | null,
    ): Promise<'removed' | 'not_found'> {
      const existing = await db.query.member.findFirst({
        where: and(eq(memberTable.id, memberId), eq(memberTable.organizationId, organizationId)),
      });
      if (!existing) return 'not_found';
      await runAuditedTransaction(db, metrics, async (tx, setAuditedAction) => {
        await tx.delete(memberTable).where(eq(memberTable.id, memberId));
        setAuditedAction('organization.member.removed');
        await insertAuditEventRow(tx, {
          organizationId,
          actorUserId,
          actorApiKeyId: null,
          action: 'organization.member.removed',
          targetType: 'member',
          targetId: memberId,
          result: 'success',
          errorCode: null,
          requestId,
          metadata: buildAuditMetadata({ roleBefore: existing.role }),
        });
      });
      return 'removed';
    },

    async countOwnersForOrganization(organizationId: string): Promise<number> {
      const rows = await db
        .select({ id: memberTable.id })
        .from(memberTable)
        .where(and(eq(memberTable.organizationId, organizationId), eq(memberTable.role, 'owner')));
      return rows.length;
    },

    async listInvitationsForOrganization(organizationId: string): Promise<InvitationSummary[]> {
      const rows = await db
        .select({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          status: invitations.status,
          expiresAt: invitations.expiresAt,
          createdAt: invitations.createdAt,
          invitedByUserId: invitations.invitedByUserId,
        })
        .from(invitations)
        .where(eq(invitations.organizationId, organizationId))
        .orderBy(asc(invitations.createdAt));
      return rows;
    },

    async getInvitationForOrganization(organizationId: string, invitationId: string) {
      return db.query.invitations.findFirst({
        where: and(eq(invitations.id, invitationId), eq(invitations.organizationId, organizationId)),
      });
    },

    async cancelInvitationForOrganization(
      organizationId: string,
      invitationId: string,
      actorUserId: string,
      requestId: string | null,
    ): Promise<'cancelled' | 'not_found' | 'already_used'> {
      const existing = await db.query.invitations.findFirst({
        where: and(eq(invitations.id, invitationId), eq(invitations.organizationId, organizationId)),
      });
      if (!existing) return 'not_found';
      if (existing.status !== 'pending') return 'already_used';
      await runAuditedTransaction(db, metrics, async (tx, setAuditedAction) => {
        await tx
          .update(invitations)
          .set({ status: 'revoked', updatedAt: new Date() })
          .where(and(eq(invitations.id, invitationId), eq(invitations.status, 'pending')));
        setAuditedAction('organization.invitation.cancelled');
        await insertAuditEventRow(tx, {
          organizationId,
          actorUserId,
          actorApiKeyId: null,
          action: 'organization.invitation.cancelled',
          targetType: 'invitation',
          targetId: invitationId,
          result: 'success',
          errorCode: null,
          requestId,
          metadata: null,
        });
      });
      return 'cancelled';
    },
  };
}

export type TenantRepository = ReturnType<typeof createTenantRepository>;
