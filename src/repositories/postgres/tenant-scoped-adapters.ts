import type { TenantRepository } from './tenant-repository.js';
import type {
  ProjectRepository,
  DomainRepository,
  SitemapRepository,
  CreateProjectInput,
  UpdateProjectInput,
  CreateDomainInput,
} from '../types.js';

// Adapts the explicit, organization-scoped TenantRepository methods
// (getProjectForOrganization, createDomainForOrganization, ...) to the
// existing ProjectRepository/DomainRepository/SitemapRepository shapes so
// the already-tested src/services/{project,domain}-service.ts business
// logic (slug derivation, verification-token generation, response DTOs)
// can be reused unchanged for the new organization-scoped routes. Every
// method here still ultimately calls a *ForOrganization query — no
// unscoped fallback is introduced.
//
// findByNormalizedHostname/findBySlug are cross-tenant-by-nature lookups
// (used only by the legacy unscoped routes, now 410) and are intentionally
// not reachable through these adapters — they throw if called.

// Actor identity for the audit trail — bound once at adapter-creation time
// (organizations.ts constructs a fresh adapter per request with the
// authenticated session's userId + that request's id) rather than threaded
// through every ProjectRepository/DomainRepository/SitemapRepository call,
// since those generic interfaces are shared with the legacy (now-410,
// non-audited) routes and their fake in-memory test implementations.
export interface AuditActorContext {
  actorUserId: string;
  requestId: string | null;
}

export function createOrgScopedProjectRepository(
  tenant: TenantRepository,
  organizationId: string,
  actor: AuditActorContext,
): ProjectRepository {
  return {
    create: (input: CreateProjectInput) => tenant.createProjectForOrganization(organizationId, input, actor.actorUserId, actor.requestId),
    findById: (id: string) => tenant.getProjectForOrganization(organizationId, id),
    findBySlug: () => {
      throw new Error('findBySlug is not available on the organization-scoped project repository');
    },
    list: (options) => tenant.listProjectsForOrganization(organizationId, options),
    update: (id: string, input: UpdateProjectInput) =>
      tenant.updateProjectForOrganization(organizationId, id, input, actor.actorUserId, actor.requestId),
    softDeleteWithCascade: (id: string) =>
      tenant.softDeleteProjectForOrganization(organizationId, id, actor.actorUserId, actor.requestId),
  };
}

export function createOrgScopedDomainRepository(
  tenant: TenantRepository,
  organizationId: string,
  actor: AuditActorContext,
): DomainRepository {
  return {
    create: (input: CreateDomainInput) =>
      tenant.createDomainForOrganization(
        organizationId,
        input.projectId,
        {
          hostname: input.hostname,
          normalizedHostname: input.normalizedHostname,
          verificationMethod: input.verificationMethod,
          verificationTokenHash: input.verificationTokenHash,
        },
        actor.actorUserId,
        actor.requestId,
      ),
    findById: (id: string) => tenant.getDomainForOrganization(organizationId, id),
    findByNormalizedHostname: () => {
      throw new Error('findByNormalizedHostname is not available on the organization-scoped domain repository');
    },
    listByProject: (projectId: string, options) =>
      tenant.listDomainsForOrganizationProject(organizationId, projectId, options),
    rotateVerificationToken: (id: string, newTokenHash: string) =>
      tenant.rotateVerificationTokenForOrganization(organizationId, id, newTokenHash, actor.actorUserId, actor.requestId),
    markVerificationAttempt: (id, result) =>
      tenant.markVerificationAttemptForOrganization(organizationId, id, result, actor.actorUserId, actor.requestId),
  };
}

// actor is accepted (not internally used yet) for signature consistency
// with the project/domain adapters above — sitemap discovery/fetch audit
// events are recorded by the route handlers directly via AuditService
// (see AUDIT_LOGGING.md), not inside these per-source upsert/record calls.
export function createOrgScopedSitemapRepository(
  tenant: TenantRepository,
  organizationId: string,
  actor: AuditActorContext,
): SitemapRepository {
  void actor;
  return {
    upsert: (input) => {
      // domainId scoping is enforced inside upsertSitemapSourceForOrganization
      // (throws DOMAIN_NOT_FOUND if the domain isn't in this org).
      return tenant.upsertSitemapSourceForOrganization(organizationId, input.domainId, input);
    },
    findById: (id: string) => tenant.getSitemapSourceForOrganization(organizationId, id),
    listByDomain: (domainId: string) => tenant.listSitemapSourcesForOrganizationDomain(organizationId, domainId),
    recordFetchResult: (id, input) => tenant.recordSitemapFetchResultForOrganization(organizationId, id, input),
  };
}
