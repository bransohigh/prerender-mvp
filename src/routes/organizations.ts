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
  createOrgScopedSitemapRepository,
} from '../repositories/postgres/tenant-scoped-adapters.js';
import { createProjectService } from '../services/project-service.js';
import { createDomainService, toPublicDomain } from '../services/domain-service.js';
import {
  verifyDomainOrThrow,
  createVerificationRateLimiter,
  createInFlightGuard,
} from '../services/domain-verification-service.js';
import { discoverSitemapSources, assertDomainVerifiedForSitemap } from '../services/sitemap-discovery-service.js';
import { createOriginCheckHook } from '../lib/csrf.js';
import { createNoopMetrics, type Metrics } from '../lib/metrics.js';

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

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
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
  const tenant = createTenantRepository(db);
  const rateLimiter = createVerificationRateLimiter();
  const inFlightGuard = createInFlightGuard();

  // Minimum CSRF protection (Milestone 2 scope): every mutating route in
  // this cookie-authenticated plugin scope requires an exact trusted
  // Origin. This hook is registered only within this plugin's
  // encapsulation, so /v1/render (registered separately, API-key
  // authenticated) is never subject to it.
  app.addHook('preHandler', createOriginCheckHook(options.trustedOrigins));

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

  // ---- projects ---------------------------------------------------------
  app.post<{ Params: { organizationId: string } }>('/organizations/:organizationId/projects', async (request, reply) => {
    try {
      const ctx = await requireOrganizationPermission(request, auth, db, request.params.organizationId, 'project.create', metrics);
      const parsed = createProjectSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten(), requestId: request.id });
      }
      const projectRepo = createOrgScopedProjectRepository(tenant, ctx.organizationId);
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
        const updated = await tenant.updateProjectForOrganization(ctx.organizationId, request.params.projectId, parsed.data);
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
        const deleted = await tenant.softDeleteProjectForOrganization(ctx.organizationId, request.params.projectId);
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

        const domainRepo = createOrgScopedDomainRepository(tenant, ctx.organizationId);
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
        const domainRepo = createOrgScopedDomainRepository(tenant, ctx.organizationId);
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
        const domainRepo = createOrgScopedDomainRepository(tenant, ctx.organizationId);
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
        const sitemapRepo = createOrgScopedSitemapRepository(tenant, ctx.organizationId);
        const result = await discoverSitemapSources(domain, sitemapRepo, { proxyUrl: options.proxyUrl });
        return reply.send({
          sources: result.sources.map((s) => ({ id: s.id, url: s.url, type: s.type, status: s.status })),
          robotsFound: result.robotsFound,
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
        const result = await tenant.cancelInvitationForOrganization(ctx.organizationId, request.params.invitationId);
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
}
