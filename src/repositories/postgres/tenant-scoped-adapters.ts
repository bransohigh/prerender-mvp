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

export function createOrgScopedProjectRepository(tenant: TenantRepository, organizationId: string): ProjectRepository {
  return {
    create: (input: CreateProjectInput) => tenant.createProjectForOrganization(organizationId, input),
    findById: (id: string) => tenant.getProjectForOrganization(organizationId, id),
    findBySlug: () => {
      throw new Error('findBySlug is not available on the organization-scoped project repository');
    },
    list: (options) => tenant.listProjectsForOrganization(organizationId, options),
    update: (id: string, input: UpdateProjectInput) => tenant.updateProjectForOrganization(organizationId, id, input),
    softDeleteWithCascade: (id: string) => tenant.softDeleteProjectForOrganization(organizationId, id),
  };
}

export function createOrgScopedDomainRepository(tenant: TenantRepository, organizationId: string): DomainRepository {
  return {
    create: (input: CreateDomainInput) =>
      tenant.createDomainForOrganization(organizationId, input.projectId, {
        hostname: input.hostname,
        normalizedHostname: input.normalizedHostname,
        verificationMethod: input.verificationMethod,
        verificationTokenHash: input.verificationTokenHash,
      }),
    findById: (id: string) => tenant.getDomainForOrganization(organizationId, id),
    findByNormalizedHostname: () => {
      throw new Error('findByNormalizedHostname is not available on the organization-scoped domain repository');
    },
    listByProject: (projectId: string, options) =>
      tenant.listDomainsForOrganizationProject(organizationId, projectId, options),
    rotateVerificationToken: (id: string, newTokenHash: string) =>
      tenant.rotateVerificationTokenForOrganization(organizationId, id, newTokenHash),
    markVerificationAttempt: (id, result) =>
      tenant.markVerificationAttemptForOrganization(organizationId, id, result),
  };
}

export function createOrgScopedSitemapRepository(tenant: TenantRepository, organizationId: string): SitemapRepository {
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
