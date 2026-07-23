import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { AppError, isAppError } from '../lib/app-error.js';
import { requireSession, requireOrganizationPermission } from '../auth/tenant-context.js';
import { organization as organizationTable, member as memberTable } from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Auth } from '../auth/auth.js';
import type { InvitationService } from '../services/invitation-service.js';
import { createTenantRepository } from '../repositories/postgres/tenant-repository.js';
import {
  createOrgScopedProjectRepository,
  createOrgScopedDomainRepository,
} from '../repositories/postgres/tenant-scoped-adapters.js';
import { createProjectService } from '../services/project-service.js';
import { createDomainService, toPublicDomain } from '../services/domain-service.js';
import {
  verifyDomainOrThrow,
  createVerificationRateLimiter,
  createInFlightGuard,
} from '../services/domain-verification-service.js';
import { scanForSitemapCandidates, assertDomainVerifiedForSitemap } from '../services/sitemap-discovery-service.js';
import { buildSitemapFetchTree, errorCodeFor, SITEMAP_FETCH_LIMITS } from '../services/sitemap-fetch-service.js';
import { createPostgresDiscoveredUrlRepository } from '../repositories/postgres/postgres-discovered-url-repository.js';
import {
  persistSitemapDiscovery,
  persistSitemapFetch,
  persistSitemapFetchFailure,
} from '../repositories/postgres/sitemap-persistence-repository.js';
import { createOriginCheckHook } from '../lib/csrf.js';
import { createNoopMetrics, type Metrics } from '../lib/metrics.js';
import { createApiKeyRepository } from '../repositories/postgres/api-key-repository.js';
import { createApiKeyService } from '../services/api-key-service.js';
import { createPostgresAuditRepository } from '../repositories/postgres/audit-repository.js';
import { createAuditService, InvalidAuditCursorError } from '../services/audit-service.js';
import { auditActionEnum, auditResultEnum } from '../db/schema.js';
import { sanitizeStoredMetadata, deriveActorType, AuditActorConsistencyError } from '../lib/audit-events.js';

const createInvitationSchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(['admin', 'member']),
});

const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(200).optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(200).optional(),
  status: z.enum(['active', 'suspended', 'deleted']).optional(),
});

const createDomainSchema = z.object({
  hostname: z.string().min(1).max(253),
  verificationMethod: z.enum(['dns_txt', 'html_file']),
});

const updateMemberRoleSchema = z.object({
  role: z.enum(['admin', 'member']),
});

const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  expiresInDays: z.coerce.number().int().min(1).max(365).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
});

// Fixed, validated target types only — never an arbitrary caller string.
const AUDIT_TARGET_TYPES = ['api_key', 'invitation', 'member', 'project', 'domain', 'sitemap_source'] as const;

const listAuditEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(200).optional(),
  action: z.enum(auditActionEnum.enumValues).optional(),
  result: z.enum(auditResultEnum.enumValues).optional(),
  targetType: z.enum(AUDIT_TARGET_TYPES).optional(),
});

export interface OrganizationRoutesOptions {
  auth: Auth;
  db: Database;
  invitationService: InvitationService;
  metrics?: Metrics;
  proxyUrl?: string;
  trustedOrigins: ReadonlySet<string>;
}

function sendAppError(err: unknown, reply: FastifyReply, requestId: string) {
  if (isAppError(err)) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message, requestId });
  }
  throw err;
}

// All organization-scoped management endpoints: browser-session
// authenticated only (never ADMIN_API_KEY), tenant-scoped at the
// repository layer via src/repositories/postgres/tenant-repository.ts, and
// role-checked via src/auth/tenant-context.ts + src/auth/permissions.ts.
// Cross-tenant resource ids resolve to ORGANIZATION_NOT_FOUND/PROJECT_NOT_FOUND
// etc (404) — never distinguishing "not a member" from "doesn't exist".
export async function organizationRoutes(app: FastifyInstance, options: OrganizationRoutesOptions): Promise<void> {
  const { auth, db, invitationService } = options;
  const metrics = options.metrics ?? createNoopMetrics();
  const tenant = createTenantRepository(db, metrics);
  const apiKeyRepo = createApiKeyRepository(db, metrics);
  const apiKeyService = createApiKeyService(tenant, apiKeyRepo);
  const auditRepo = createPostgresAuditRepository(db, metrics);
  const auditService = createAuditService(auditRepo);
  const rateLimiter = createVerificationRateLimiter();
  const inFlightGuard = createInFlightGuard();

  // Minimum CSRF protection (Milestone 2 scope): every mutating route in
  // this cookie-authenticated plugin scope requires an exact trusted
  // Origin. This hook is registered only within this plugin's
  // encapsulation, so /v1/render (registered separately, API-key
  // authenticated) is never subject to it.
  app.addHook('preHandler', createOriginCheckHook(options.trustedOrigins, metrics));

  // ---- organizations --------------------------------------------------
  app.get('/organizations', async (request, reply) => {
    try {
      const session = await requireSession(request, auth);
      const rows = await db
        .select({ organization: organizationTable, role: memberTable.role })
        .from(memberTable)
        .innerJoin(organizationTable, eq(memberTable.organizationId, organizationTable.id))
        .where(eq(memberTable.userId, session.userId));
      return reply.send({
        items: rows.map((r) => ({ id: r.organization.id, name: r.organization.name, slug: r.organization.slug, role: r.role })),
      });
    } catch (err) {
      return sendAppError(err, reply, request.id);
    }
  });

  app.get<{ Params: { organizationId: string } }>('/organizations/:organizationId', async (request, reply) => {
    try {
      const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'organization.read', metrics);
      const org = await db.query.organization.findFirst({ where: eq(organizationTable.id, ctx.organizationId) });
      if (!org) throw new AppError('ORGANIZATION_NOT_FOUND', 'Organization not found');
      return reply.send({ id: org.id, name: org.name, slug: org.slug, role: ctx.role });
    } catch (err) {
      return sendAppError(err, reply, request.id);
    }
  });

  app.get<{ Params: { organizationId: string } }>('/organizations/:organizationId/members', async (request, reply) => {
    try {
      await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'member.list', metrics);
      const members = await tenant.listMembersForOrganization(request.params.organizationId);
      // Deliberately excludes password/account/session data — only
      // userId/email/name/role/createdAt, matching the invitation-list
      // secret policy below.
      return reply.send({ items: members });
    } catch (err) {
      return sendAppError(err, reply, request.id);
    }
  });

  // ---- audit history ------------------------------------------------------
  // Owner/admin only (audit.read permission — see src/auth/permissions.ts);
  // member gets 403 FORBIDDEN_ROLE, a non-member gets 404
  // ORGANIZATION_NOT_FOUND, via requireOrganizationPermission. Never
  // reachable with a project render API key or any legacy global key —
  // this whole plugin scope is cookie-session-only (see app.ts).
  app.get<{ Params: { organizationId: string } }>('/organizations/:organizationId/audit-events', async (request, reply) => {
    try {
      const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'audit.read', metrics);
      const parsed = listAuditEventsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        request.log.info({ event: 'audit.read.denied', errorCode: 'invalid_request' }, 'audit read denied');
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten(), requestId: request.id });
      }
      let page;
      try {
        page = await auditService.list({
          organizationId: ctx.organizationId,
          limit: parsed.data.limit,
          cursor: parsed.data.cursor ?? null,
          action: parsed.data.action,
          result: parsed.data.result,
          targetType: parsed.data.targetType,
        });
      } catch (err) {
        if (err instanceof InvalidAuditCursorError) {
          return reply.code(400).send({ error: 'invalid_cursor', message: 'Malformed cursor', requestId: request.id });
        }
        throw err;
      }

      const items = [];
      for (const row of page.items) {
        let actorType;
        try {
          actorType = deriveActorType({ actorUserId: row.actorUserId, actorApiKeyId: row.actorApiKeyId });
        } catch (err) {
          if (err instanceof AuditActorConsistencyError) {
            request.log.error({ event: 'audit.read.denied', errorCode: 'actor_consistency', targetType: row.targetType, targetId: row.targetId }, 'audit row skipped: actor consistency violation');
            continue;
          }
          throw err;
        }
        items.push({
          id: row.id,
          action: row.action,
          result: row.result,
          actorType,
          actorUserId: row.actorUserId,
          actorApiKeyId: row.actorApiKeyId,
          targetType: row.targetType,
          targetId: row.targetId,
          errorCode: row.errorCode,
          requestId: row.requestId,
          metadata: sanitizeStoredMetadata(row.metadata),
          createdAt: row.createdAt.toISOString(),
        });
      }

      request.log.info({ event: 'audit.read.success', organizationId: ctx.organizationId, count: items.length }, 'audit read');
      return reply.send({ items, nextCursor: page.nextCursor });
    } catch (err) {
      return sendAppError(err, reply, request.id);
    }
  });

  // ---- projects ---------------------------------------------------------
  app.post<{ Params: { organizationId: string } }>('/organizations/:organizationId/projects', async (request, reply) => {
    try {
      const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'project.create', metrics);
      const parsed = createProjectSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten(), requestId: request.id });
      }
      const projectRepo = createOrgScopedProjectRepository(tenant, ctx.organizationId, { actorUserId: ctx.userId, requestId: request.id });
      const projectService = createProjectService(projectRepo);
      const project = await projectService.createProject(parsed.data);
      return reply.code(201).send(project);
    } catch (err) {
      return sendAppError(err, reply, request.id);
    }
  });

  app.get<{ Params: { organizationId: string } }>('/organizations/:organizationId/projects', async (request, reply) => {
    try {
      const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'project.read', metrics);
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten(), requestId: request.id });
      }
      const page = await tenant.listProjectsForOrganization(ctx.organizationId, { limit: parsed.data.limit, cursor: parsed.data.cursor });
      return reply.send(page);
    } catch (err) {
      return sendAppError(err, reply, request.id);
    }
  });

  app.get<{ Params: { organizationId: string; projectId: string } }>(
    '/organizations/:organizationId/projects/:projectId',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'project.read', metrics);
        const project = await tenant.getProjectForOrganization(ctx.organizationId, request.params.projectId);
        if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
        return reply.send(project);
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  app.patch<{ Params: { organizationId: string; projectId: string } }>(
    '/organizations/:organizationId/projects/:projectId',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'project.update', metrics);
        const parsed = updateProjectSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten(), requestId: request.id });
        }
        const updated = await tenant.updateProjectForOrganization(ctx.organizationId, request.params.projectId, parsed.data, ctx.userId, request.id);
        if (!updated) throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
        return reply.send(updated);
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  app.delete<{ Params: { organizationId: string; projectId: string } }>(
    '/organizations/:organizationId/projects/:projectId',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'project.delete', metrics);
        const deleted = await tenant.softDeleteProjectForOrganization(ctx.organizationId, request.params.projectId, ctx.userId, request.id);
        if (!deleted) throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
        return reply.send(deleted);
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  // ---- domains ------------------------------------------------------
  app.post<{ Params: { organizationId: string; projectId: string } }>(
    '/organizations/:organizationId/projects/:projectId/domains',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'domain.create', metrics);
        const parsed = createDomainSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten(), requestId: request.id });
        }
        const project = await tenant.getProjectForOrganization(ctx.organizationId, request.params.projectId);
        if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project not found');

        const domainRepo = createOrgScopedDomainRepository(tenant, ctx.organizationId, { actorUserId: ctx.userId, requestId: request.id });
        const domainService = createDomainService(domainRepo);
        const result = await domainService.createDomain({
          projectId: project.id,
          hostname: parsed.data.hostname,
          verificationMethod: parsed.data.verificationMethod,
        });
        return reply.code(201).send({
          domain: toPublicDomain(result.domain),
          verification: { ...result.verification, token: result.plaintextToken },
        });
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  app.get<{ Params: { organizationId: string; projectId: string } }>(
    '/organizations/:organizationId/projects/:projectId/domains',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'domain.read', metrics);
        const parsed = listQuerySchema.safeParse(request.query);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten(), requestId: request.id });
        }
        const project = await tenant.getProjectForOrganization(ctx.organizationId, request.params.projectId);
        if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
        const page = await tenant.listDomainsForOrganizationProject(ctx.organizationId, project.id, {
          limit: parsed.data.limit,
          cursor: parsed.data.cursor,
        });
        return reply.send({ items: page.items.map(toPublicDomain), nextCursor: page.nextCursor });
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  app.get<{ Params: { organizationId: string; domainId: string } }>(
    '/organizations/:organizationId/domains/:domainId',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'domain.read', metrics);
        const domain = await tenant.getDomainForOrganization(ctx.organizationId, request.params.domainId);
        if (!domain) throw new AppError('DOMAIN_NOT_FOUND', 'Domain not found');
        return reply.send(toPublicDomain(domain));
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  app.post<{ Params: { organizationId: string; domainId: string } }>(
    '/organizations/:organizationId/domains/:domainId/rotate-verification-token',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'domain.rotate_token', metrics);
        const domainRepo = createOrgScopedDomainRepository(tenant, ctx.organizationId, { actorUserId: ctx.userId, requestId: request.id });
        const domainService = createDomainService(domainRepo);
        const result = await domainService.rotateToken(request.params.domainId);
        return reply.send({
          domain: toPublicDomain(result.domain),
          verification: { ...result.verification, token: result.plaintextToken },
        });
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  app.post<{ Params: { organizationId: string; domainId: string } }>(
    '/organizations/:organizationId/domains/:domainId/verify',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'domain.verify', metrics);
        const domain = await tenant.getDomainForOrganization(ctx.organizationId, request.params.domainId);
        if (!domain) throw new AppError('DOMAIN_NOT_FOUND', 'Domain not found');
        // Two-stage network-operation pattern (AUDIT_LOGGING.md): a short,
        // standalone "attempted" write happens here BEFORE any DNS/HTTP
        // work starts — if it throws, verification never starts. The
        // succeeded/failed outcome is written atomically together with
        // the final domain state inside
        // markVerificationAttemptForOrganization's own transaction (see
        // tenant-repository.ts), reached via verifyDomainOrThrow below —
        // never with a database transaction held open across the network
        // call itself.
        await auditService.record({
          organizationId: ctx.organizationId,
          actor: { type: 'user', userId: ctx.userId },
          action: 'domain.verification.attempted',
          targetType: 'domain',
          targetId: domain.id,
          result: 'success',
          requestId: request.id,
          metadata: { verificationMethod: domain.verificationMethod },
        });
        const domainRepo = createOrgScopedDomainRepository(tenant, ctx.organizationId, { actorUserId: ctx.userId, requestId: request.id });
        const verified = await verifyDomainOrThrow(domain, domainRepo, rateLimiter, inFlightGuard, { proxyUrl: options.proxyUrl }, metrics);
        return reply.send(toPublicDomain(verified));
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  app.post<{ Params: { organizationId: string; domainId: string } }>(
    '/organizations/:organizationId/domains/:domainId/discover-sitemaps',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'sitemap.discover', metrics);
        const domain = await tenant.getDomainForOrganization(ctx.organizationId, request.params.domainId);
        if (!domain) throw new AppError('DOMAIN_NOT_FOUND', 'Domain not found');
        assertDomainVerifiedForSitemap(domain);
        // Two-stage network-operation pattern (AUDIT_LOGGING.md): a short
        // standalone `started` write, then pure network work (no DB
        // access at all — see sitemap-discovery-service.ts), then ONE
        // transaction that upserts every discovered source AND the final
        // completed/failed audit event together (persistSitemapDiscovery
        // in sitemap-persistence-repository.ts) — never held open across
        // the network call, and never partially committed.
        await auditService.record({
          organizationId: ctx.organizationId,
          actor: { type: 'user', userId: ctx.userId },
          action: 'sitemap.discovery.started',
          targetType: 'domain',
          targetId: domain.id,
          result: 'success',
          requestId: request.id,
        });
        let scan;
        try {
          scan = await scanForSitemapCandidates(domain, { proxyUrl: options.proxyUrl });
        } catch (err) {
          // Network phase itself threw (rare — scanForSitemapCandidates
          // normally falls back to defaults on robots.txt failure): no
          // database mutation was ever attempted, so a standalone
          // (non-transactional) failed event is correct here — there is
          // nothing to roll back.
          await auditService.record({
            organizationId: ctx.organizationId,
            actor: { type: 'user', userId: ctx.userId },
            action: 'sitemap.discovery.failed',
            targetType: 'domain',
            targetId: domain.id,
            result: 'failure',
            requestId: request.id,
            metadata: { reasonCode: isAppError(err) ? err.code : 'unknown' },
          });
          throw err;
        }
        const persisted = await persistSitemapDiscovery(db, metrics, {
          organizationId: ctx.organizationId,
          domainId: domain.id,
          candidates: scan.candidates,
          actorUserId: ctx.userId,
          requestId: request.id,
        });
        return reply.send({
          sources: persisted.map((s) => ({ id: s.id, url: s.url, type: s.type, status: s.status })),
          robotsFound: scan.robotsFound,
        });
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  // ---- invitations ------------------------------------------------------
  app.post<{ Params: { organizationId: string } }>('/organizations/:organizationId/invitations', async (request, reply) => {
    try {
      const parsed = createInvitationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten(), requestId: request.id });
      }
      const permission = parsed.data.role === 'admin' ? 'invitation.create.admin' : 'invitation.create.member';
      const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, permission, metrics);

      const result = await invitationService.createInvitation({
        organizationId: ctx.organizationId,
        email: parsed.data.email,
        role: parsed.data.role,
        invitedByUserId: ctx.userId,
        requestId: request.id,
      });

      return reply.code(201).send({ id: result.id, token: result.token, expiresAt: result.expiresAt.toISOString() });
    } catch (err) {
      return sendAppError(err, reply, request.id);
    }
  });

  app.get<{ Params: { organizationId: string } }>('/organizations/:organizationId/invitations', async (request, reply) => {
    try {
      const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'invitation.list', metrics);
      const items = await tenant.listInvitationsForOrganization(ctx.organizationId);
      // Never token/hash — only metadata needed to manage invitations.
      return reply.send({ items });
    } catch (err) {
      return sendAppError(err, reply, request.id);
    }
  });

  app.delete<{ Params: { organizationId: string; invitationId: string } }>(
    '/organizations/:organizationId/invitations/:invitationId',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'invitation.cancel', metrics);
        const result = await tenant.cancelInvitationForOrganization(ctx.organizationId, request.params.invitationId, ctx.userId, request.id);
        if (result === 'not_found') throw new AppError('INVITATION_NOT_FOUND', 'Invitation not found');
        if (result === 'already_used') {
          return reply.code(409).send({ error: 'INVITATION_ALREADY_USED', requestId: request.id });
        }
        return reply.code(200).send({ status: 'cancelled' });
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  // ---- members ----------------------------------------------------------
  // Conservative Milestone-2 policy: only owner may change roles or remove
  // members; owner membership itself can never be changed or removed by
  // anyone (including that owner) — ownership transfer is unsupported.
  app.patch<{ Params: { organizationId: string; memberId: string } }>(
    '/organizations/:organizationId/members/:memberId',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'member.role.change', metrics);
        const parsed = updateMemberRoleSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten(), requestId: request.id });
        }
        const target = await tenant.getMemberForOrganization(ctx.organizationId, request.params.memberId);
        if (!target) throw new AppError('MEMBER_NOT_FOUND', 'Member not found');
        if (target.role === 'owner') {
          throw new AppError('FORBIDDEN_ROLE', 'Owner membership cannot be changed');
        }
        const updated = await tenant.updateMemberRoleForOrganization(ctx.organizationId, request.params.memberId, parsed.data.role, ctx.userId, request.id);
        if (!updated) throw new AppError('MEMBER_NOT_FOUND', 'Member not found');
        return reply.send(updated);
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  app.delete<{ Params: { organizationId: string; memberId: string } }>(
    '/organizations/:organizationId/members/:memberId',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'member.remove', metrics);
        const target = await tenant.getMemberForOrganization(ctx.organizationId, request.params.memberId);
        if (!target) throw new AppError('MEMBER_NOT_FOUND', 'Member not found');
        if (target.role === 'owner') {
          // Blanket protection: covers both "the final owner" and
          // "an owner removing themselves" without needing to special-case
          // actor-vs-target, since ownership transfer isn't supported yet.
          throw new AppError('FORBIDDEN_ROLE', 'Owner membership cannot be removed');
        }
        const result = await tenant.removeMemberForOrganization(ctx.organizationId, request.params.memberId, ctx.userId, request.id);
        if (result === 'not_found') throw new AppError('MEMBER_NOT_FOUND', 'Member not found');
        return reply.code(200).send({ status: 'removed' });
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  // ---- sitemap sources ----------------------------------------------------
  app.get<{ Params: { organizationId: string; sourceId: string } }>(
    '/organizations/:organizationId/sitemap-sources/:sourceId',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'sitemap.read', metrics);
        const source = await tenant.getSitemapSourceForOrganization(ctx.organizationId, request.params.sourceId);
        if (!source) throw new AppError('SITEMAP_SOURCE_NOT_FOUND', 'Sitemap source not found');
        return reply.send({ id: source.id, domainId: source.domainId, url: source.url, type: source.type, status: source.status, discoveredUrlCount: source.discoveredUrlCount });
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  app.post<{ Params: { organizationId: string; sourceId: string } }>(
    '/organizations/:organizationId/sitemap-sources/:sourceId/fetch',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'sitemap.fetch', metrics);
        const source = await tenant.getSitemapSourceForOrganization(ctx.organizationId, request.params.sourceId);
        if (!source) throw new AppError('SITEMAP_SOURCE_NOT_FOUND', 'Sitemap source not found');
        const domain = await tenant.getDomainForOrganization(ctx.organizationId, source.domainId);
        if (!domain) throw new AppError('DOMAIN_NOT_FOUND', 'Domain not found');
        if (domain.status !== 'verified') {
          throw new AppError('DOMAIN_NOT_VERIFIED', 'Domain must be verified before fetching sitemaps');
        }

        // Two-stage network-operation pattern (AUDIT_LOGGING.md): a short
        // standalone `started` write, then pure network fetch/decompress/
        // parse with no database access at all (buildSitemapFetchTree,
        // src/services/sitemap-fetch-service.ts — recursion respects the
        // existing maxIndexDepth/maxNestedSitemapsPerIndex/
        // maxUrlsPerSitemap/maxDecompressedBytes/per-domain URL-total
        // limits unchanged), then ONE transaction persists every
        // discovered URL, every nested sitemap_source's final status, and
        // the top-level source's own final status together with the
        // completed/failed audit event (persistSitemapFetch /
        // persistSitemapFetchFailure in
        // sitemap-persistence-repository.ts) — never held open across the
        // network call, and never partially committed.
        const discoveredUrlRepo = createPostgresDiscoveredUrlRepository(db);
        const startedAt = Date.now();
        await auditService.record({
          organizationId: ctx.organizationId,
          actor: { type: 'user', userId: ctx.userId },
          action: 'sitemap.fetch.started',
          targetType: 'sitemap_source',
          targetId: source.id,
          result: 'success',
          requestId: request.id,
          metadata: { sitemapType: source.type },
        });
        let tree;
        try {
          const existingTotal = await discoveredUrlRepo.countByDomain(domain.id);
          tree = await buildSitemapFetchTree(
            domain,
            source.normalizedUrl,
            0,
            { nestedCount: 0, remainingUrlBudget: Math.max(0, SITEMAP_FETCH_LIMITS.maxTotalUrlsPerDomain - existingTotal) },
            { proxyUrl: options.proxyUrl },
          );
        } catch (err) {
          const errorCode = errorCodeFor(err);
          await persistSitemapFetchFailure(db, metrics, {
            organizationId: ctx.organizationId,
            sourceId: source.id,
            sourceType: source.type,
            errorCode,
            actorUserId: ctx.userId,
            requestId: request.id,
          });
          metrics.incrementSitemapFetch(source.type, 'failure');
          metrics.observeSitemapFetchDuration((Date.now() - startedAt) / 1000);
          if (err instanceof AppError) throw err;
          throw new AppError('SITEMAP_FETCH_FAILED', `Sitemap fetch failed: ${errorCode}`);
        }
        const persisted = await persistSitemapFetch(db, metrics, {
          organizationId: ctx.organizationId,
          domainId: domain.id,
          sourceId: source.id,
          sourceType: source.type,
          tree,
          actorUserId: ctx.userId,
          requestId: request.id,
        });
        metrics.incrementSitemapFetch(source.type, 'success');
        metrics.incrementSitemapUrlsDiscovered(persisted.discoveredCount);
        metrics.observeSitemapFetchDuration((Date.now() - startedAt) / 1000);
        return reply.send({ sitemapSourceId: source.id, discoveredCount: persisted.discoveredCount });
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  // ---- project-scoped render API keys ------------------------------------
  app.post<{ Params: { organizationId: string; projectId: string } }>(
    '/organizations/:organizationId/projects/:projectId/api-keys',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'api_key.create', metrics);
        const parsed = createApiKeySchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten(), requestId: request.id });
        }
        const result = await apiKeyService.createKey({
          organizationId: ctx.organizationId,
          projectId: request.params.projectId,
          name: parsed.data.name,
          expiresInDays: parsed.data.expiresInDays,
          createdByUserId: ctx.userId,
          requestId: request.id,
        });
        return reply.code(201).send(result);
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  app.get<{ Params: { organizationId: string; projectId: string } }>(
    '/organizations/:organizationId/projects/:projectId/api-keys',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'api_key.list', metrics);
        const items = await apiKeyService.listKeys(ctx.organizationId, request.params.projectId);
        return reply.send({ items });
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  app.delete<{ Params: { organizationId: string; projectId: string; keyId: string } }>(
    '/organizations/:organizationId/projects/:projectId/api-keys/:keyId',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'api_key.revoke', metrics);
        const result = await apiKeyService.revokeKey(ctx.organizationId, request.params.projectId, request.params.keyId, ctx.userId, request.id);
        if (result === 'not_found') throw new AppError('API_KEY_NOT_FOUND', 'API key not found');
        if (result === 'already_revoked') {
          return reply.code(409).send({ error: 'API_KEY_REVOKED', requestId: request.id });
        }
        return reply.code(200).send({ status: 'revoked' });
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );

  app.post<{ Params: { organizationId: string; projectId: string; keyId: string } }>(
    '/organizations/:organizationId/projects/:projectId/api-keys/:keyId/rotate',
    async (request, reply) => {
      try {
        const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'api_key.rotate', metrics);
        const result = await apiKeyService.rotateKey(ctx.organizationId, request.params.projectId, request.params.keyId, ctx.userId, request.id);
        if (result === 'not_found') throw new AppError('API_KEY_NOT_FOUND', 'API key not found');
        if (result === 'already_revoked' || result === 'already_rotated') {
          return reply.code(409).send({ error: 'API_KEY_REVOKED', requestId: request.id });
        }
        if (result === 'expired') {
          return reply.code(409).send({ error: 'API_KEY_EXPIRED', requestId: request.id });
        }
        return reply.code(201).send(result);
      } catch (err) {
        return sendAppError(err, reply, request.id);
      }
    },
  );
}
