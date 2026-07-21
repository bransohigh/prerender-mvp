import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDbClient, truncateAll } from './helpers.js';
import { createTenantRepository } from '../../src/repositories/postgres/tenant-repository.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { hashVerificationToken, generateVerificationToken } from '../../src/lib/verification-token.js';
import { member as memberTable } from '../../src/db/schema.js';
import type { DbClient } from '../../src/db/client.js';

let client: DbClient;
let auth: Auth;
let tenant: ReturnType<typeof createTenantRepository>;

beforeEach(async () => {
  client ??= createTestDbClient();
  auth ??= createAuth(client.db);
  await truncateAll(client);
  tenant = createTenantRepository(client.db);
});

afterAll(async () => {
  await client?.close();
});

interface OrgFixture {
  organizationId: string;
  ownerUserId: string;
  projectId: string;
  domainId: string;
}

async function createOrgWithProjectAndDomain(label: string): Promise<OrgFixture> {
  const signUp = await auth.api.signUpEmail({
    body: { email: `owner-${label}@example.com`, name: `Owner ${label}`, password: 'correct-horse-battery-staple' },
  });
  const org = await auth.api.createOrganization({
    body: { name: `Org ${label}`, slug: `repo-org-${label}-${Date.now()}`, userId: signUp.user.id },
  });
  if (!org) throw new Error('org create failed');

  const existing = await client.db.query.member.findFirst({
    where: and(eq(memberTable.organizationId, org.id), eq(memberTable.userId, signUp.user.id)),
  });
  if (existing) {
    await client.db.update(memberTable).set({ role: 'owner' }).where(eq(memberTable.id, existing.id));
  } else {
    await client.db.insert(memberTable).values({
      id: `mem_${signUp.user.id}_${org.id}`,
      organizationId: org.id,
      userId: signUp.user.id,
      role: 'owner',
      createdAt: new Date(),
    });
  }

  const project = await tenant.createProjectForOrganization(org.id, { name: `Project ${label}`, slug: `project-${label}-${Date.now()}` });
  const domain = await tenant.createDomainForOrganization(org.id, project.id, {
    hostname: `${label}.example.com`,
    normalizedHostname: `${label}.example.com`,
    verificationMethod: 'dns_txt',
    verificationTokenHash: hashVerificationToken(generateVerificationToken()),
  });

  return { organizationId: org.id, ownerUserId: signUp.user.id, projectId: project.id, domainId: domain.id };
}

describe('tenant repository isolation, per resource type', () => {
  describe('project', () => {
    it('org A retrieves its own project; cannot retrieve org B project; list excludes B; update/delete scoped to A cannot affect B', async () => {
      const a = await createOrgWithProjectAndDomain('proj-a');
      const b = await createOrgWithProjectAndDomain('proj-b');

      expect((await tenant.getProjectForOrganization(a.organizationId, a.projectId))?.id).toBe(a.projectId);
      expect(await tenant.getProjectForOrganization(a.organizationId, b.projectId)).toBeNull();

      const listA = await tenant.listProjectsForOrganization(a.organizationId, { limit: 50 });
      expect(listA.items.map((p) => p.id)).not.toContain(b.projectId);

      const updateResult = await tenant.updateProjectForOrganization(a.organizationId, b.projectId, { name: 'Hijacked' });
      expect(updateResult).toBeNull();
      const bStillIntact = await tenant.getProjectForOrganization(b.organizationId, b.projectId);
      expect(bStillIntact?.name).toBe('Project proj-b');

      const deleteResult = await tenant.softDeleteProjectForOrganization(a.organizationId, b.projectId);
      expect(deleteResult).toBeNull();
      const bStillActive = await tenant.getProjectForOrganization(b.organizationId, b.projectId);
      expect(bStillActive?.status).toBe('active');
    });
  });

  describe('domain', () => {
    it('org A retrieves its own domain; cannot retrieve org B domain; list excludes B; rotate scoped to A cannot affect B', async () => {
      const a = await createOrgWithProjectAndDomain('dom-a');
      const b = await createOrgWithProjectAndDomain('dom-b');

      expect((await tenant.getDomainForOrganization(a.organizationId, a.domainId))?.id).toBe(a.domainId);
      expect(await tenant.getDomainForOrganization(a.organizationId, b.domainId)).toBeNull();

      const listA = await tenant.listDomainsForOrganizationProject(a.organizationId, a.projectId, { limit: 50 });
      expect(listA.items.map((d) => d.id)).not.toContain(b.domainId);
      expect(listA.items.map((d) => d.id)).toContain(a.domainId);

      const bDomainBefore = await tenant.getDomainForOrganization(b.organizationId, b.domainId);
      const rotateResult = await tenant.rotateVerificationTokenForOrganization(a.organizationId, b.domainId, 'x'.repeat(64));
      expect(rotateResult).toBeNull();
      const bDomainAfter = await tenant.getDomainForOrganization(b.organizationId, b.domainId);
      expect(bDomainAfter?.verificationTokenHash).toBe(bDomainBefore?.verificationTokenHash);
    });
  });

  describe('sitemap source', () => {
    it('org A retrieves its own source; cannot retrieve org B source; list excludes B; fetch-result update scoped to A cannot affect B', async () => {
      const a = await createOrgWithProjectAndDomain('sm-a');
      const b = await createOrgWithProjectAndDomain('sm-b');

      const sourceA = await tenant.upsertSitemapSourceForOrganization(a.organizationId, a.domainId, {
        url: 'https://sm-a.example.com/sitemap.xml',
        normalizedUrl: 'https://sm-a.example.com/sitemap.xml',
        type: 'sitemap',
      });
      const sourceB = await tenant.upsertSitemapSourceForOrganization(b.organizationId, b.domainId, {
        url: 'https://sm-b.example.com/sitemap.xml',
        normalizedUrl: 'https://sm-b.example.com/sitemap.xml',
        type: 'sitemap',
      });

      expect((await tenant.getSitemapSourceForOrganization(a.organizationId, sourceA.id))?.id).toBe(sourceA.id);
      expect(await tenant.getSitemapSourceForOrganization(a.organizationId, sourceB.id)).toBeNull();

      const listA = await tenant.listSitemapSourcesForOrganizationDomain(a.organizationId, a.domainId);
      expect(listA.map((s) => s.id)).toEqual([sourceA.id]);

      // Cross-org upsert must be rejected even before touching the sitemap
      // table: attaching a "new" source for a domain outside the caller's
      // org must fail with DOMAIN_NOT_FOUND, not silently succeed.
      await expect(
        tenant.upsertSitemapSourceForOrganization(a.organizationId, b.domainId, {
          url: 'https://sneaky.example.com/sitemap.xml',
          normalizedUrl: 'https://sneaky.example.com/sitemap.xml',
          type: 'sitemap',
        }),
      ).rejects.toThrow();

      const updateResult = await tenant.recordSitemapFetchResultForOrganization(a.organizationId, sourceB.id, { status: 'success', discoveredUrlCount: 999 });
      expect(updateResult).toBeNull();
      const sourceBAfter = await tenant.getSitemapSourceForOrganization(b.organizationId, sourceB.id);
      expect(sourceBAfter?.discoveredUrlCount).toBe(0);
    });
  });

  describe('discovered url', () => {
    it('listing discovered URLs is organization-scoped', async () => {
      const a = await createOrgWithProjectAndDomain('durl-a');
      const b = await createOrgWithProjectAndDomain('durl-b');

      const { createPostgresDiscoveredUrlRepository } = await import('../../src/repositories/postgres/postgres-discovered-url-repository.js');
      const rawRepo = createPostgresDiscoveredUrlRepository(client.db);
      await rawRepo.upsertMany([
        { domainId: a.domainId, sitemapSourceId: null, url: 'https://durl-a.example.com/page', normalizedUrl: 'https://durl-a.example.com/page', path: '/page' },
      ]);
      await rawRepo.upsertMany([
        { domainId: b.domainId, sitemapSourceId: null, url: 'https://durl-b.example.com/page', normalizedUrl: 'https://durl-b.example.com/page', path: '/page' },
      ]);

      const listA = await tenant.listDiscoveredUrlsForOrganization(a.organizationId, a.domainId, { limit: 50 });
      expect(listA.items).toHaveLength(1);
      expect(listA.items[0]!.url).toContain('durl-a');

      // Cross-org: asking for org A's scope but org B's domainId returns
      // nothing (the JOIN's organization_id condition excludes it).
      const crossList = await tenant.listDiscoveredUrlsForOrganization(a.organizationId, b.domainId, { limit: 50 });
      expect(crossList.items).toHaveLength(0);
    });
  });

  describe('invitation', () => {
    it('org A retrieves its own invitation; cannot retrieve org B invitation; list excludes B; cancel scoped to A cannot affect B', async () => {
      const a = await createOrgWithProjectAndDomain('inv-a');
      const b = await createOrgWithProjectAndDomain('inv-b');
      const { createInvitationService } = await import('../../src/services/invitation-service.js');
      const invitationService = createInvitationService(client.db);

      const inviteA = await invitationService.createInvitation({ organizationId: a.organizationId, email: 'x@a.example.com', role: 'member', invitedByUserId: a.ownerUserId });
      const inviteB = await invitationService.createInvitation({ organizationId: b.organizationId, email: 'x@b.example.com', role: 'member', invitedByUserId: b.ownerUserId });

      expect((await tenant.getInvitationForOrganization(a.organizationId, inviteA.id))?.id).toBe(inviteA.id);
      expect(await tenant.getInvitationForOrganization(a.organizationId, inviteB.id)).toBeUndefined();

      const listA = await tenant.listInvitationsForOrganization(a.organizationId);
      expect(listA.map((i) => i.id)).toEqual([inviteA.id]);

      const cancelResult = await tenant.cancelInvitationForOrganization(a.organizationId, inviteB.id);
      expect(cancelResult).toBe('not_found');
      const bInviteAfter = await tenant.getInvitationForOrganization(b.organizationId, inviteB.id);
      expect(bInviteAfter?.status).toBe('pending');
    });
  });

  describe('member', () => {
    it('org A retrieves its own member; cannot retrieve org B member; list excludes B; role-change/remove scoped to A cannot affect B', async () => {
      const a = await createOrgWithProjectAndDomain('mem-a');
      const b = await createOrgWithProjectAndDomain('mem-b');

      const aMembership = await tenant.getMembershipForOrganization(a.organizationId, a.ownerUserId);
      expect(aMembership).not.toBeNull();
      const aMemberId = aMembership!.id;

      const bMembership = await tenant.getMembershipForOrganization(b.organizationId, b.ownerUserId);
      const bMemberId = bMembership!.id;

      expect((await tenant.getMemberForOrganization(a.organizationId, aMemberId))?.userId).toBe(a.ownerUserId);
      expect(await tenant.getMemberForOrganization(a.organizationId, bMemberId)).toBeNull();

      const listA = await tenant.listMembersForOrganization(a.organizationId);
      expect(listA.map((m) => m.userId)).toEqual([a.ownerUserId]);

      // Add a non-owner member to B so the role-change/remove attempt below
      // targets a mutable row (owner protection is tested separately at
      // the route layer).
      const bMemberSignUp = await auth.api.signUpEmail({ body: { email: 'plain-member-b@example.com', name: 'Plain', password: 'correct-horse-battery-staple' } });
      await client.db.insert(memberTable).values({
        id: `mem_${bMemberSignUp.user.id}_${b.organizationId}`,
        organizationId: b.organizationId,
        userId: bMemberSignUp.user.id,
        role: 'member',
        createdAt: new Date(),
      });
      const bPlainMembership = await tenant.getMembershipForOrganization(b.organizationId, bMemberSignUp.user.id);

      const roleChangeResult = await tenant.updateMemberRoleForOrganization(a.organizationId, bPlainMembership!.id, 'admin');
      expect(roleChangeResult).toBeNull();
      const bPlainAfter = await tenant.getMemberForOrganization(b.organizationId, bPlainMembership!.id);
      expect(bPlainAfter?.role).toBe('member');

      const removeResult = await tenant.removeMemberForOrganization(a.organizationId, bPlainMembership!.id);
      expect(removeResult).toBe('not_found');
      expect(await tenant.getMemberForOrganization(b.organizationId, bPlainMembership!.id)).not.toBeNull();
    });
  });
});
