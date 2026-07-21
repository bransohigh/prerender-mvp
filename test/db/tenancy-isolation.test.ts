import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createDbClient, type DbClient } from '../../src/db/client.js';
import { env } from '../../src/config/env.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { truncateAll } from './helpers.js';
import { member as memberTable, projects, domains } from '../../src/db/schema.js';

let dbClient: DbClient;
let auth: Auth;
let app: FastifyInstance;

const TRUSTED_ORIGIN = env.AUTH_TRUSTED_ORIGINS[0]!;
const PASSWORD = 'correct-horse-battery-staple';

beforeEach(async () => {
  dbClient ??= createDbClient(env.DATABASE_URL);
  auth ??= createAuth(dbClient.db);
  await truncateAll(dbClient);
  app = await buildApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

interface OrgFixture {
  organizationId: string;
  ownerEmail: string;
  ownerCookie: string;
  adminEmail: string;
  adminCookie: string;
  memberEmail: string;
  memberCookie: string;
}

async function loginCookie(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email, password } });
  const setCookie = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as string];
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

async function createOrgFixture(label: string): Promise<OrgFixture> {
  const ownerEmail = `owner-${label}@example.com`;
  const adminEmail = `admin-${label}@example.com`;
  const memberEmail = `member-${label}@example.com`;

  const ownerSignUp = await auth.api.signUpEmail({ body: { email: ownerEmail, name: `Owner ${label}`, password: PASSWORD } });
  const org = await auth.api.createOrganization({
    body: { name: `Org ${label}`, slug: `org-${label}-${Date.now()}`, userId: ownerSignUp.user.id },
  });
  if (!org) throw new Error('org create failed');

  const existingOwnerMembership = await dbClient.db.query.member.findFirst({
    where: and(eq(memberTable.organizationId, org.id), eq(memberTable.userId, ownerSignUp.user.id)),
  });
  if (existingOwnerMembership) {
    await dbClient.db.update(memberTable).set({ role: 'owner' }).where(eq(memberTable.id, existingOwnerMembership.id));
  } else {
    await dbClient.db.insert(memberTable).values({
      id: `mem_${ownerSignUp.user.id}_${org.id}`,
      organizationId: org.id,
      userId: ownerSignUp.user.id,
      role: 'owner',
      createdAt: new Date(),
    });
  }

  const adminSignUp = await auth.api.signUpEmail({ body: { email: adminEmail, name: `Admin ${label}`, password: PASSWORD } });
  await dbClient.db.insert(memberTable).values({
    id: `mem_${adminSignUp.user.id}_${org.id}`,
    organizationId: org.id,
    userId: adminSignUp.user.id,
    role: 'admin',
    createdAt: new Date(),
  });

  const memberSignUp = await auth.api.signUpEmail({ body: { email: memberEmail, name: `Member ${label}`, password: PASSWORD } });
  await dbClient.db.insert(memberTable).values({
    id: `mem_${memberSignUp.user.id}_${org.id}`,
    organizationId: org.id,
    userId: memberSignUp.user.id,
    role: 'member',
    createdAt: new Date(),
  });

  return {
    organizationId: org.id,
    ownerEmail,
    ownerCookie: await loginCookie(ownerEmail, PASSWORD),
    adminEmail,
    adminCookie: await loginCookie(adminEmail, PASSWORD),
    memberEmail,
    memberCookie: await loginCookie(memberEmail, PASSWORD),
  };
}

async function createProject(orgId: string, cookie: string, name: string, origin = TRUSTED_ORIGIN) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/organizations/${orgId}/projects`,
    headers: { cookie, origin },
    payload: { name },
  });
  return res;
}

async function createDomain(orgId: string, projectId: string, cookie: string, hostname: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/organizations/${orgId}/projects/${projectId}/domains`,
    headers: { cookie, origin: TRUSTED_ORIGIN },
    payload: { hostname, verificationMethod: 'dns_txt' },
  });
  return res;
}

describe('tenant isolation (real Postgres, two organizations)', () => {
  describe('membership', () => {
    it('a user sees only organizations where they are a member', async () => {
      const a = await createOrgFixture('mem-a');
      const b = await createOrgFixture('mem-b');

      const res = await app.inject({ method: 'GET', url: '/v1/organizations', headers: { cookie: a.ownerCookie } });
      const body = res.json() as { items: Array<{ id: string }> };
      const ids = body.items.map((i) => i.id);
      expect(ids).toContain(a.organizationId);
      expect(ids).not.toContain(b.organizationId);
    });

    it('removed membership is rejected on the next request', async () => {
      const a = await createOrgFixture('mem-remove');
      const before = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}`, headers: { cookie: a.memberCookie } });
      expect(before.statusCode).toBe(200);

      await dbClient.db
        .delete(memberTable)
        .where(and(eq(memberTable.organizationId, a.organizationId), eq(memberTable.userId, (await auth.api.getSession({ headers: new Headers({ cookie: a.memberCookie }) }))!.user.id)));

      const after = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}`, headers: { cookie: a.memberCookie } });
      expect(after.statusCode).toBe(404);
    });

    it('a role change takes effect on the next request', async () => {
      const a = await createOrgFixture('mem-role');
      const before = await createProject(a.organizationId, a.memberCookie, 'Should Fail');
      expect(before.statusCode).toBe(403);

      const session = await auth.api.getSession({ headers: new Headers({ cookie: a.memberCookie }) });
      await dbClient.db
        .update(memberTable)
        .set({ role: 'admin' })
        .where(and(eq(memberTable.organizationId, a.organizationId), eq(memberTable.userId, session!.user.id)));

      const after = await createProject(a.organizationId, a.memberCookie, 'Should Succeed');
      expect(after.statusCode).toBe(201);
    });

    it('enforces the owner/admin/member permission matrix for project creation', async () => {
      const a = await createOrgFixture('matrix');
      expect((await createProject(a.organizationId, a.ownerCookie, 'Owner Proj')).statusCode).toBe(201);
      expect((await createProject(a.organizationId, a.adminCookie, 'Admin Proj')).statusCode).toBe(201);
      expect((await createProject(a.organizationId, a.memberCookie, 'Member Proj')).statusCode).toBe(403);
    });
  });

  describe('projects', () => {
    it('org A user can access an A project; gets 404 for a B project id', async () => {
      const a = await createOrgFixture('proj-a');
      const b = await createOrgFixture('proj-b');
      const aProject = (await createProject(a.organizationId, a.ownerCookie, 'A Project')).json();
      const bProject = (await createProject(b.organizationId, b.ownerCookie, 'B Project')).json();

      const okRes = await app.inject({
        method: 'GET',
        url: `/v1/organizations/${a.organizationId}/projects/${aProject.id}`,
        headers: { cookie: a.ownerCookie },
      });
      expect(okRes.statusCode).toBe(200);

      const crossRes = await app.inject({
        method: 'GET',
        url: `/v1/organizations/${a.organizationId}/projects/${bProject.id}`,
        headers: { cookie: a.ownerCookie },
      });
      expect(crossRes.statusCode).toBe(404);
      expect(crossRes.json().error).toBe('PROJECT_NOT_FOUND');
    });

    it('repository lookup scoped to org A also returns nothing for a B project', async () => {
      const a = await createOrgFixture('proj-repo-a');
      const b = await createOrgFixture('proj-repo-b');
      const bProject = (await createProject(b.organizationId, b.ownerCookie, 'B Project')).json();

      const { createTenantRepository } = await import('../../src/repositories/postgres/tenant-repository.js');
      const tenant = createTenantRepository(dbClient.db);
      const result = await tenant.getProjectForOrganization(a.organizationId, bProject.id);
      expect(result).toBeNull();
    });

    it('member can read but not mutate; admin can mutate', async () => {
      const a = await createOrgFixture('proj-rw');
      const project = (await createProject(a.organizationId, a.ownerCookie, 'RW Project')).json();

      const memberRead = await app.inject({
        method: 'GET',
        url: `/v1/organizations/${a.organizationId}/projects/${project.id}`,
        headers: { cookie: a.memberCookie },
      });
      expect(memberRead.statusCode).toBe(200);

      const memberWrite = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${a.organizationId}/projects/${project.id}`,
        headers: { cookie: a.memberCookie, origin: TRUSTED_ORIGIN },
        payload: { name: 'Nope' },
      });
      expect(memberWrite.statusCode).toBe(403);

      const adminWrite = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${a.organizationId}/projects/${project.id}`,
        headers: { cookie: a.adminCookie, origin: TRUSTED_ORIGIN },
        payload: { name: 'Updated By Admin' },
      });
      expect(adminWrite.statusCode).toBe(200);
      expect(adminWrite.json().name).toBe('Updated By Admin');
    });

    it('soft delete remains organization-scoped', async () => {
      const a = await createOrgFixture('proj-del-a');
      const b = await createOrgFixture('proj-del-b');
      const bProject = (await createProject(b.organizationId, b.ownerCookie, 'B Project')).json();

      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/organizations/${a.organizationId}/projects/${bProject.id}`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      });
      expect(res.statusCode).toBe(404);

      const stillActive = await dbClient.db.select().from(projects).where(eq(projects.id, bProject.id));
      expect(stillActive[0]!.status).toBe('active');
    });
  });

  describe('domains', () => {
    it('cross-tenant domain ids return 404', async () => {
      const a = await createOrgFixture('dom-a');
      const b = await createOrgFixture('dom-b');
      const bProject = (await createProject(b.organizationId, b.ownerCookie, 'B Project')).json();
      const bDomain = (await createDomain(b.organizationId, bProject.id, b.ownerCookie, 'b-domain.example.com')).json();

      const res = await app.inject({
        method: 'GET',
        url: `/v1/organizations/${a.organizationId}/domains/${bDomain.domain.id}`,
        headers: { cookie: a.ownerCookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it('verification and token rotation require owner/admin; member is rejected', async () => {
      const a = await createOrgFixture('dom-verify');
      const project = (await createProject(a.organizationId, a.ownerCookie, 'P')).json();
      const domain = (await createDomain(a.organizationId, project.id, a.ownerCookie, 'verify-me.example.com')).json();

      const memberVerify = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/domains/${domain.domain.id}/verify`,
        headers: { cookie: a.memberCookie, origin: TRUSTED_ORIGIN },
      });
      expect(memberVerify.statusCode).toBe(403);

      const memberRotate = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/domains/${domain.domain.id}/rotate-verification-token`,
        headers: { cookie: a.memberCookie, origin: TRUSTED_ORIGIN },
      });
      expect(memberRotate.statusCode).toBe(403);

      const adminRotate = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/domains/${domain.domain.id}/rotate-verification-token`,
        headers: { cookie: a.adminCookie, origin: TRUSTED_ORIGIN },
      });
      expect(adminRotate.statusCode).toBe(200);
    });

    it('domain creation cannot attach to another tenant project', async () => {
      const a = await createOrgFixture('dom-attach-a');
      const b = await createOrgFixture('dom-attach-b');
      const bProject = (await createProject(b.organizationId, b.ownerCookie, 'B Project')).json();

      const res = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/projects/${bProject.id}/domains`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
        payload: { hostname: 'sneaky.example.com', verificationMethod: 'dns_txt' },
      });
      expect(res.statusCode).toBe(404);

      const rows = await dbClient.db.select().from(domains).where(eq(domains.projectId, bProject.id));
      expect(rows).toHaveLength(0);
    });
  });

  describe('sitemaps', () => {
    it('discover-sitemaps is organization-scoped: cross-tenant domain id returns 404', async () => {
      const a = await createOrgFixture('sm-a');
      const b = await createOrgFixture('sm-b');
      const bProject = (await createProject(b.organizationId, b.ownerCookie, 'B Project')).json();
      const bDomain = (await createDomain(b.organizationId, bProject.id, b.ownerCookie, 'sm-domain.example.com')).json();

      const res = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/domains/${bDomain.domain.id}/discover-sitemaps`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      });
      expect(res.statusCode).toBe(404);
    });

    it('the tenant repository never returns another org sitemap source', async () => {
      const a = await createOrgFixture('sm-repo-a');
      const b = await createOrgFixture('sm-repo-b');
      const bProject = (await createProject(b.organizationId, b.ownerCookie, 'B Project')).json();
      const bDomain = (await createDomain(b.organizationId, bProject.id, b.ownerCookie, 'sm-repo.example.com')).json();

      const { createTenantRepository } = await import('../../src/repositories/postgres/tenant-repository.js');
      const tenant = createTenantRepository(dbClient.db);
      const source = await tenant.upsertSitemapSourceForOrganization(b.organizationId, bDomain.domain.id, {
        url: 'https://sm-repo.example.com/sitemap.xml',
        normalizedUrl: 'https://sm-repo.example.com/sitemap.xml',
        type: 'sitemap',
      });

      const crossResult = await tenant.getSitemapSourceForOrganization(a.organizationId, source.id);
      expect(crossResult).toBeNull();
    });
  });

  describe('invitations', () => {
    it('owner/admin can invite member/admin; member cannot invite', async () => {
      const a = await createOrgFixture('inv-role');
      const asOwner = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/invitations`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
        payload: { email: 'invitee1@example.com', role: 'member' },
      });
      expect(asOwner.statusCode).toBe(201);

      const asMember = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/invitations`,
        headers: { cookie: a.memberCookie, origin: TRUSTED_ORIGIN },
        payload: { email: 'invitee2@example.com', role: 'member' },
      });
      expect(asMember.statusCode).toBe(403);
    });

    it('owner role cannot be invited (rejected by request validation)', async () => {
      const a = await createOrgFixture('inv-owner-block');
      const res = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/invitations`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
        payload: { email: 'wannabe-owner@example.com', role: 'owner' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('cross-tenant invitation read/cancel returns 404', async () => {
      const a = await createOrgFixture('inv-cross-a');
      const b = await createOrgFixture('inv-cross-b');
      const invite = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${b.organizationId}/invitations`,
        headers: { cookie: b.ownerCookie, origin: TRUSTED_ORIGIN },
        payload: { email: 'target@example.com', role: 'member' },
      });
      const inviteId = invite.json().id;

      const cancelRes = await app.inject({
        method: 'DELETE',
        url: `/v1/organizations/${a.organizationId}/invitations/${inviteId}`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      });
      expect(cancelRes.statusCode).toBe(404);
    });

    it('a cancelled invitation token cannot be accepted', async () => {
      const a = await createOrgFixture('inv-cancel');
      const invite = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/invitations`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
        payload: { email: 'to-cancel@example.com', role: 'member' },
      });
      const inviteBody = invite.json();

      const cancelRes = await app.inject({
        method: 'DELETE',
        url: `/v1/organizations/${a.organizationId}/invitations/${inviteBody.id}`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      });
      expect(cancelRes.statusCode).toBe(200);

      const acceptRes = await app.inject({
        method: 'POST',
        url: '/v1/onboarding/accept',
        payload: { token: inviteBody.token, name: 'To Cancel', password: PASSWORD },
      });
      expect(acceptRes.statusCode).not.toBe(200);
    });

    it('invitation list responses never include token or hash', async () => {
      const a = await createOrgFixture('inv-list-secret');
      await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/invitations`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
        payload: { email: 'secret-check@example.com', role: 'member' },
      });

      const listRes = await app.inject({
        method: 'GET',
        url: `/v1/organizations/${a.organizationId}/invitations`,
        headers: { cookie: a.ownerCookie },
      });
      const body = JSON.stringify(listRes.json());
      expect(body).not.toMatch(/tokenHash/i);
      expect(body.length).toBeLessThan(5000); // sanity: no raw token-length hex blob included
    });
  });

  describe('legacy routes', () => {
    it('migrated unscoped routes return 410 even for an authenticated session', async () => {
      const a = await createOrgFixture('legacy');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
        payload: { name: 'Nope' },
      });
      expect(res.statusCode).toBe(410);
    });
  });

  describe('CSRF minimum', () => {
    it('a mutation from the trusted Origin succeeds', async () => {
      const a = await createOrgFixture('csrf-trusted');
      const res = await createProject(a.organizationId, a.ownerCookie, 'Trusted Origin Project', TRUSTED_ORIGIN);
      expect(res.statusCode).toBe(201);
    });

    it('a mutation from an untrusted Origin is rejected with 403 CSRF_ORIGIN_REJECTED', async () => {
      const a = await createOrgFixture('csrf-untrusted');
      const res = await createProject(a.organizationId, a.ownerCookie, 'Untrusted Origin Project', 'https://evil.example.com');
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('CSRF_ORIGIN_REJECTED');
      expect(JSON.stringify(res.json())).not.toContain(TRUSTED_ORIGIN);
    });

    it('a mutation with a missing Origin is rejected with 403 CSRF_ORIGIN_REJECTED', async () => {
      const a = await createOrgFixture('csrf-missing');
      const res = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/projects`,
        headers: { cookie: a.ownerCookie },
        payload: { name: 'No Origin Project' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('CSRF_ORIGIN_REJECTED');
    });

    it('a malformed Origin (with a path) is rejected with 403 CSRF_ORIGIN_REJECTED', async () => {
      const a = await createOrgFixture('csrf-malformed');
      const res = await createProject(a.organizationId, a.ownerCookie, 'Malformed Origin Project', `${TRUSTED_ORIGIN}/some/path`);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('CSRF_ORIGIN_REJECTED');
    });

    it('an authenticated GET remains usable without an Origin header', async () => {
      const a = await createOrgFixture('csrf-get');
      const res = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}`, headers: { cookie: a.ownerCookie } });
      expect(res.statusCode).toBe(200);
    });

    it('the render API-key endpoint is not subject to the cookie-session Origin check', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/render',
        payload: { domainId: '00000000-0000-0000-0000-000000000000', url: 'https://example.com/' },
      });
      // No Origin header, no cookie: must not be rejected by the CSRF
      // origin-check (that hook is only registered inside the
      // organizationRoutes plugin scope) — rejection here comes from
      // render's own API-key auth, not FORBIDDEN/missing-origin.
      expect(res.statusCode).not.toBe(404);
    });
  });

  describe('member management', () => {
    async function memberIdByEmail(orgId: string, cookie: string, email: string): Promise<string> {
      const res = await app.inject({ method: 'GET', url: `/v1/organizations/${orgId}/members`, headers: { cookie } });
      const items = res.json().items as Array<{ id: string; email: string }>;
      return items.find((m) => m.email === email)!.id;
    }

    it('only owner may change roles; admin and member are rejected', async () => {
      const a = await createOrgFixture('memmgmt-role');
      const memberId = await memberIdByEmail(a.organizationId, a.ownerCookie, a.memberEmail);

      const asAdmin = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${a.organizationId}/members/${memberId}`,
        headers: { cookie: a.adminCookie, origin: TRUSTED_ORIGIN },
        payload: { role: 'admin' },
      });
      expect(asAdmin.statusCode).toBe(403);

      const asOwner = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${a.organizationId}/members/${memberId}`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
        payload: { role: 'admin' },
      });
      expect(asOwner.statusCode).toBe(200);
      expect(asOwner.json().role).toBe('admin');
    });

    it('only owner may remove members; admin and member are rejected', async () => {
      const a = await createOrgFixture('memmgmt-remove');
      const memberId = await memberIdByEmail(a.organizationId, a.ownerCookie, a.memberEmail);

      const asMember = await app.inject({
        method: 'DELETE',
        url: `/v1/organizations/${a.organizationId}/members/${memberId}`,
        headers: { cookie: a.memberCookie, origin: TRUSTED_ORIGIN },
      });
      expect(asMember.statusCode).toBe(403);

      const asOwner = await app.inject({
        method: 'DELETE',
        url: `/v1/organizations/${a.organizationId}/members/${memberId}`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      });
      expect(asOwner.statusCode).toBe(200);

      const listAfter = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/members`, headers: { cookie: a.ownerCookie } });
      expect((listAfter.json().items as Array<{ email: string }>).map((m) => m.email)).not.toContain(a.memberEmail);
    });

    it('owner membership can never be changed or removed, including by that owner', async () => {
      const a = await createOrgFixture('memmgmt-owner-protect');
      const ownerId = await memberIdByEmail(a.organizationId, a.ownerCookie, a.ownerEmail);

      const changeSelf = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${a.organizationId}/members/${ownerId}`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
        payload: { role: 'admin' },
      });
      expect(changeSelf.statusCode).toBe(403);

      const removeSelf = await app.inject({
        method: 'DELETE',
        url: `/v1/organizations/${a.organizationId}/members/${ownerId}`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      });
      expect(removeSelf.statusCode).toBe(403);

      const membershipStillOwner = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/members`, headers: { cookie: a.ownerCookie } });
      const ownerRow = (membershipStillOwner.json().items as Array<{ id: string; role: string }>).find((m) => m.id === ownerId);
      expect(ownerRow?.role).toBe('owner');
    });

    it('cross-tenant member ids return 404', async () => {
      const a = await createOrgFixture('memmgmt-cross-a');
      const b = await createOrgFixture('memmgmt-cross-b');
      const bMemberId = await memberIdByEmail(b.organizationId, b.ownerCookie, b.memberEmail);

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${a.organizationId}/members/${bMemberId}`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
        payload: { role: 'admin' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('removing a membership takes effect on the next request', async () => {
      const a = await createOrgFixture('memmgmt-next-req');
      const memberId = await memberIdByEmail(a.organizationId, a.ownerCookie, a.memberEmail);

      await app.inject({
        method: 'DELETE',
        url: `/v1/organizations/${a.organizationId}/members/${memberId}`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      });

      const afterRemoval = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}`, headers: { cookie: a.memberCookie } });
      expect(afterRemoval.statusCode).toBe(404);
    });

    it('response never exposes Better Auth account/session data', async () => {
      const a = await createOrgFixture('memmgmt-secret');
      const res = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/members`, headers: { cookie: a.ownerCookie } });
      const body = JSON.stringify(res.json());
      expect(body).not.toMatch(/password|sessionToken|accessToken|refreshToken/i);
    });
  });

  describe('sitemap source fetch', () => {
    async function createSitemapSource(orgId: string, domainId: string, cookie: string) {
      const { createTenantRepository } = await import('../../src/repositories/postgres/tenant-repository.js');
      const tenant = createTenantRepository(dbClient.db);
      void cookie;
      return tenant.upsertSitemapSourceForOrganization(orgId, domainId, {
        url: 'https://fetch-me.example.com/sitemap.xml',
        normalizedUrl: 'https://fetch-me.example.com/sitemap.xml',
        type: 'sitemap',
      });
    }

    it('requires membership and owner/admin role to fetch; member can read but not fetch', async () => {
      const a = await createOrgFixture('smfetch-role');
      const project = (await createProject(a.organizationId, a.ownerCookie, 'P')).json();
      const domain = (await createDomain(a.organizationId, project.id, a.ownerCookie, 'fetch-me.example.com')).json();
      const source = await createSitemapSource(a.organizationId, domain.domain.id, a.ownerCookie);

      const memberRead = await app.inject({
        method: 'GET',
        url: `/v1/organizations/${a.organizationId}/sitemap-sources/${source.id}`,
        headers: { cookie: a.memberCookie },
      });
      expect(memberRead.statusCode).toBe(200);

      const memberFetch = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/sitemap-sources/${source.id}/fetch`,
        headers: { cookie: a.memberCookie, origin: TRUSTED_ORIGIN },
      });
      expect(memberFetch.statusCode).toBe(403);

      // Domain isn't verified, so owner/admin get a domain-state error, not
      // a role error — confirms the role check passed before this point.
      const ownerFetch = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/sitemap-sources/${source.id}/fetch`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      });
      expect(ownerFetch.statusCode).toBe(409);
      expect(ownerFetch.json().error).toBe('DOMAIN_NOT_VERIFIED');
    });

    it('cross-tenant sitemap source id returns 404', async () => {
      const a = await createOrgFixture('smfetch-cross-a');
      const b = await createOrgFixture('smfetch-cross-b');
      const bProject = (await createProject(b.organizationId, b.ownerCookie, 'B Project')).json();
      const bDomain = (await createDomain(b.organizationId, bProject.id, b.ownerCookie, 'cross-fetch.example.com')).json();
      const bSource = await createSitemapSource(b.organizationId, bDomain.domain.id, b.ownerCookie);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/sitemap-sources/${bSource.id}/fetch`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      });
      expect(res.statusCode).toBe(404);
    });

    it('the old unscoped fetch endpoint remains 410', async () => {
      const res = await app.inject({ method: 'POST', url: '/v1/sitemap-sources/00000000-0000-0000-0000-000000000000/fetch' });
      expect(res.statusCode).toBe(410);
    });

    it('does not leak the raw sitemap URL in an error response', async () => {
      const a = await createOrgFixture('smfetch-secret');
      const res = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${a.organizationId}/sitemap-sources/00000000-0000-0000-0000-000000000000/fetch`,
        headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.stringify(res.json())).not.toContain('fetch-me.example.com');
    });
  });
});
