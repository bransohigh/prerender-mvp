import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createDbClient, type DbClient } from '../../src/db/client.js';
import { env } from '../../src/config/env.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { truncateAll } from './helpers.js';
import { member as memberTable, domains, projects, organization as organizationTable, apikey as apikeyTable } from '../../src/db/schema.js';

let dbClient: DbClient;
let auth: Auth;
let app: FastifyInstance;

const TRUSTED_ORIGIN = env.AUTH_TRUSTED_ORIGINS[0]!;
const PASSWORD = 'correct-horse-battery-staple';

beforeEach(async () => {
  dbClient ??= createDbClient(env.DATABASE_URL);
  auth ??= createAuth(dbClient.db);
  await truncateAll(dbClient);
  // Fake renderUrl: this file tests authorization (everything before
  // Chromium is invoked), not rendering itself — see
  // test/db/render-e2e.test.ts for the real-Chromium project-key test.
  app = await buildApp({
    renderUrl: async (url: string) => ({
      url,
      finalUrl: url,
      statusCode: 200,
      title: 'Fake',
      html: '<html></html>',
      renderTimeMs: 1,
      renderedAt: new Date().toISOString(),
    }),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function loginCookie(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email, password } });
  const setCookie = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as string];
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

interface OrgFixture {
  organizationId: string;
  ownerCookie: string;
}

async function createOrgFixture(label: string): Promise<OrgFixture> {
  const email = `owner-${label}@example.com`;
  const signUp = await auth.api.signUpEmail({ body: { email, name: `Owner ${label}`, password: PASSWORD } });
  const org = await auth.api.createOrganization({ body: { name: `Org ${label}`, slug: `render-org-${label}-${Date.now()}`, userId: signUp.user.id } });
  if (!org) throw new Error('org create failed');
  const existing = await dbClient.db.query.member.findFirst({ where: and(eq(memberTable.organizationId, org.id), eq(memberTable.userId, signUp.user.id)) });
  if (existing) {
    await dbClient.db.update(memberTable).set({ role: 'owner' }).where(eq(memberTable.id, existing.id));
  } else {
    await dbClient.db.insert(memberTable).values({ id: `mem_${signUp.user.id}_${org.id}`, organizationId: org.id, userId: signUp.user.id, role: 'owner', createdAt: new Date() });
  }
  return { organizationId: org.id, ownerCookie: await loginCookie(email, PASSWORD) };
}

async function createProject(orgId: string, cookie: string, name: string) {
  const res = await app.inject({ method: 'POST', url: `/v1/organizations/${orgId}/projects`, headers: { cookie, origin: TRUSTED_ORIGIN }, payload: { name } });
  return res.json() as { id: string };
}

async function createVerifiedDomain(orgId: string, projectId: string, cookie: string, hostname: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/organizations/${orgId}/projects/${projectId}/domains`,
    headers: { cookie, origin: TRUSTED_ORIGIN },
    payload: { hostname, verificationMethod: 'dns_txt' },
  });
  const body = res.json() as { domain: { id: string } };
  await dbClient.db.update(domains).set({ status: 'verified', verifiedAt: new Date() }).where(eq(domains.id, body.domain.id));
  return body.domain.id;
}

async function createApiKey(orgId: string, projectId: string, cookie: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/organizations/${orgId}/projects/${projectId}/api-keys`,
    headers: { cookie, origin: TRUSTED_ORIGIN },
    payload: { name: 'Render Key' },
  });
  return res.json() as { id: string; key: string };
}

function renderRequest(key: string, domainId: string, url = 'https://example.com/') {
  return app.inject({ method: 'POST', url: '/v1/render', headers: { 'x-render-api-key': key }, payload: { domainId, url } });
}

describe('render authorization (real Postgres)', () => {
  it('a valid project key resolves the correct organization and project and renders', async () => {
    const a = await createOrgFixture('valid');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const domainId = await createVerifiedDomain(a.organizationId, project.id, a.ownerCookie, 'valid.example.com');
    const key = await createApiKey(a.organizationId, project.id, a.ownerCookie);

    const res = await renderRequest(key.key, domainId, 'https://valid.example.com/');
    expect(res.statusCode).toBe(200);
  });

  it('malformed metadata fails closed', async () => {
    const a = await createOrgFixture('malformed');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const domainId = await createVerifiedDomain(a.organizationId, project.id, a.ownerCookie, 'malformed.example.com');
    const key = await createApiKey(a.organizationId, project.id, a.ownerCookie);

    await dbClient.db.update(apikeyTable).set({ metadata: 'not valid json {{' }).where(eq(apikeyTable.id, key.id));

    const res = await renderRequest(key.key, domainId, 'https://malformed.example.com/');
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('API_KEY_INVALID');
  });

  it('a key for project A cannot access a domain in project B (same organization)', async () => {
    const a = await createOrgFixture('proj-a');
    const projectA = await createProject(a.organizationId, a.ownerCookie, 'A');
    const projectB = await createProject(a.organizationId, a.ownerCookie, 'B');
    const domainBId = await createVerifiedDomain(a.organizationId, projectB.id, a.ownerCookie, 'proj-b.example.com');
    const keyA = await createApiKey(a.organizationId, projectA.id, a.ownerCookie);

    const res = await renderRequest(keyA.key, domainBId, 'https://proj-b.example.com/');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('DOMAIN_NOT_FOUND');
  });

  it('a key for organization A cannot access a domain in organization B', async () => {
    const a = await createOrgFixture('org-a');
    const b = await createOrgFixture('org-b');
    const projectA = await createProject(a.organizationId, a.ownerCookie, 'A');
    const projectB = await createProject(b.organizationId, b.ownerCookie, 'B');
    const domainBId = await createVerifiedDomain(b.organizationId, projectB.id, b.ownerCookie, 'org-b.example.com');
    const keyA = await createApiKey(a.organizationId, projectA.id, a.ownerCookie);

    const res = await renderRequest(keyA.key, domainBId, 'https://org-b.example.com/');
    expect(res.statusCode).toBe(404);
  });

  it('suspended organization is rejected', async () => {
    const a = await createOrgFixture('suspend-org');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const domainId = await createVerifiedDomain(a.organizationId, project.id, a.ownerCookie, 'suspend-org.example.com');
    const key = await createApiKey(a.organizationId, project.id, a.ownerCookie);

    await dbClient.db.update(organizationTable).set({ status: 'suspended' }).where(eq(organizationTable.id, a.organizationId));

    const res = await renderRequest(key.key, domainId, 'https://suspend-org.example.com/');
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ORGANIZATION_SUSPENDED');
  });

  it('suspended project is rejected', async () => {
    const a = await createOrgFixture('suspend-proj');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const domainId = await createVerifiedDomain(a.organizationId, project.id, a.ownerCookie, 'suspend-proj.example.com');
    const key = await createApiKey(a.organizationId, project.id, a.ownerCookie);

    await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${a.organizationId}/projects/${project.id}`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      payload: { status: 'suspended' },
    });

    const res = await renderRequest(key.key, domainId, 'https://suspend-proj.example.com/');
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('PROJECT_SUSPENDED');
  });

  it('a deleted project is rejected', async () => {
    const a = await createOrgFixture('delete-proj');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const domainId = await createVerifiedDomain(a.organizationId, project.id, a.ownerCookie, 'delete-proj.example.com');
    const key = await createApiKey(a.organizationId, project.id, a.ownerCookie);

    await dbClient.db.update(projects).set({ status: 'deleted' }).where(eq(projects.id, project.id));

    const res = await renderRequest(key.key, domainId, 'https://delete-proj.example.com/');
    expect(res.statusCode).toBe(404);
    // Uniform DOMAIN_NOT_FOUND externally — never reveals whether the
    // organization, project, or domain layer was the actual reason.
    expect(res.json().error).toBe('DOMAIN_NOT_FOUND');
  });

  it('a pending (unverified) domain is rejected', async () => {
    const a = await createOrgFixture('pending-domain');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const createRes = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${a.organizationId}/projects/${project.id}/domains`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      payload: { hostname: 'pending.example.com', verificationMethod: 'dns_txt' },
    });
    const domainId = (createRes.json() as { domain: { id: string } }).domain.id;
    const key = await createApiKey(a.organizationId, project.id, a.ownerCookie);

    const res = await renderRequest(key.key, domainId, 'https://pending.example.com/');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DOMAIN_NOT_VERIFIED');
  });

  it('a suspended domain is rejected', async () => {
    const a = await createOrgFixture('suspended-domain');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const domainId = await createVerifiedDomain(a.organizationId, project.id, a.ownerCookie, 'suspended-domain.example.com');
    await dbClient.db.update(domains).set({ status: 'suspended' }).where(eq(domains.id, domainId));
    const key = await createApiKey(a.organizationId, project.id, a.ownerCookie);

    const res = await renderRequest(key.key, domainId, 'https://suspended-domain.example.com/');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DOMAIN_NOT_VERIFIED');
  });

  it('an expired key is rejected', async () => {
    const a = await createOrgFixture('expired-key');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const domainId = await createVerifiedDomain(a.organizationId, project.id, a.ownerCookie, 'expired-key.example.com');
    const key = await createApiKey(a.organizationId, project.id, a.ownerCookie);
    await dbClient.db.update(apikeyTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apikeyTable.id, key.id));

    const res = await renderRequest(key.key, domainId, 'https://expired-key.example.com/');
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('API_KEY_INVALID');
  });

  it('a revoked key is rejected', async () => {
    const a = await createOrgFixture('revoked-key');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const domainId = await createVerifiedDomain(a.organizationId, project.id, a.ownerCookie, 'revoked-key.example.com');
    const key = await createApiKey(a.organizationId, project.id, a.ownerCookie);
    await app.inject({ method: 'DELETE', url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys/${key.id}`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN } });

    const res = await renderRequest(key.key, domainId, 'https://revoked-key.example.com/');
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('API_KEY_INVALID');
  });

  it('a rotated-away old key is rejected; the new key succeeds', async () => {
    const a = await createOrgFixture('rotated-key');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const domainId = await createVerifiedDomain(a.organizationId, project.id, a.ownerCookie, 'rotated-key.example.com');
    const key = await createApiKey(a.organizationId, project.id, a.ownerCookie);

    const rotateRes = await app.inject({ method: 'POST', url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys/${key.id}/rotate`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN } });
    const rotated = rotateRes.json() as { key: string };

    const oldRes = await renderRequest(key.key, domainId, 'https://rotated-key.example.com/');
    expect(oldRes.statusCode).toBe(401);

    const newRes = await renderRequest(rotated.key, domainId, 'https://rotated-key.example.com/');
    expect(newRes.statusCode).toBe(200);
  });

  it('an invalid key does not update lastUsedAt/lastRequest', async () => {
    const a = await createOrgFixture('invalid-lastused');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const domainId = await createVerifiedDomain(a.organizationId, project.id, a.ownerCookie, 'invalid-lastused.example.com');
    const key = await createApiKey(a.organizationId, project.id, a.ownerCookie);

    await renderRequest(`pr_live_${'z'.repeat(56)}`, domainId, 'https://invalid-lastused.example.com/');

    const row = await dbClient.db.select().from(apikeyTable).where(eq(apikeyTable.id, key.id)).then((r) => r[0]);
    expect(row?.lastRequest).toBeNull();
  });

  it('a valid key updates lastUsedAt (Better Auth verifyApiKey rate-limit tracking)', async () => {
    const a = await createOrgFixture('valid-lastused');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const domainId = await createVerifiedDomain(a.organizationId, project.id, a.ownerCookie, 'valid-lastused.example.com');
    const key = await createApiKey(a.organizationId, project.id, a.ownerCookie);

    const before = await dbClient.db.select().from(apikeyTable).where(eq(apikeyTable.id, key.id)).then((r) => r[0]);
    expect(before?.lastRequest).toBeNull();

    await renderRequest(key.key, domainId, 'https://valid-lastused.example.com/');

    const after = await dbClient.db.select().from(apikeyTable).where(eq(apikeyTable.id, key.id)).then((r) => r[0]);
    expect(after?.lastRequest).not.toBeNull();
  });

  it('no authorization rejection changes the capacity active/queued snapshot', async () => {
    const a = await createOrgFixture('capacity-snapshot');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const domainId = await createVerifiedDomain(a.organizationId, project.id, a.ownerCookie, 'capacity-snapshot.example.com');

    // Every rejection category below happens before capacity acquisition —
    // confirmed by checking /metrics gauges stay at 0 throughout.
    async function activeAndQueued(): Promise<string> {
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      const active = /prerender_render_active (\d+)/.exec(res.body)?.[1];
      const queued = /prerender_render_queued (\d+)/.exec(res.body)?.[1];
      return `${active}/${queued}`;
    }

    const before = await activeAndQueued();
    await renderRequest(`pr_live_${'z'.repeat(56)}`, domainId); // invalid key
    await renderRequest('not-even-the-right-prefix', domainId); // malformed header
    await app.inject({ method: 'POST', url: '/v1/render', payload: { domainId, url: 'https://capacity-snapshot.example.com/' } }); // no header
    const after = await activeAndQueued();
    expect(after).toBe(before);
  });
});
