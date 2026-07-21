import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createDbClient, type DbClient } from '../../src/db/client.js';
import { env } from '../../src/config/env.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { truncateAll } from './helpers.js';
import { member as memberTable } from '../../src/db/schema.js';

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

async function loginCookie(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email, password } });
  const setCookie = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as string];
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

async function createOwner(label: string): Promise<{ organizationId: string; cookie: string }> {
  const email = `owner-${label}@example.com`;
  const signUp = await auth.api.signUpEmail({ body: { email, name: `Owner ${label}`, password: PASSWORD } });
  const org = await auth.api.createOrganization({ body: { name: `Org ${label}`, slug: `conc-org-${label}-${Date.now()}`, userId: signUp.user.id } });
  if (!org) throw new Error('org create failed');
  const existing = await dbClient.db.query.member.findFirst({
    where: and(eq(memberTable.organizationId, org.id), eq(memberTable.userId, signUp.user.id)),
  });
  if (existing) {
    await dbClient.db.update(memberTable).set({ role: 'owner' }).where(eq(memberTable.id, existing.id));
  } else {
    await dbClient.db.insert(memberTable).values({ id: `mem_${signUp.user.id}_${org.id}`, organizationId: org.id, userId: signUp.user.id, role: 'owner', createdAt: new Date() });
  }
  return { organizationId: org.id, cookie: await loginCookie(email, PASSWORD) };
}

describe('concurrent tenant-context isolation (single Fastify instance)', () => {
  it('never mixes up organization context between simultaneous A and B requests', async () => {
    const a = await createOwner('conc-a');
    const b = await createOwner('conc-b');

    // Fire 20 interleaved create-project requests (10 for A, 10 for B)
    // concurrently against the same running app instance. Each
    // organizationRoutes handler constructs its tenant-scoped
    // repository/service instances fresh, per call
    // (createOrgScopedProjectRepository(tenant, ctx.organizationId) inside
    // the route body) — never at plugin-registration time — so there is
    // no shared mutable state an interleaved request could corrupt.
    const requests: Promise<{ orgLabel: 'a' | 'b'; status: number; body: { organizationId?: string; name?: string } }>[] = [];
    for (let i = 0; i < 10; i++) {
      requests.push(
        app
          .inject({
            method: 'POST',
            url: `/v1/organizations/${a.organizationId}/projects`,
            headers: { cookie: a.cookie, origin: TRUSTED_ORIGIN },
            payload: { name: `A-Project-${i}` },
          })
          .then((res) => ({ orgLabel: 'a' as const, status: res.statusCode, body: res.json() })),
      );
      requests.push(
        app
          .inject({
            method: 'POST',
            url: `/v1/organizations/${b.organizationId}/projects`,
            headers: { cookie: b.cookie, origin: TRUSTED_ORIGIN },
            payload: { name: `B-Project-${i}` },
          })
          .then((res) => ({ orgLabel: 'b' as const, status: res.statusCode, body: res.json() })),
      );
    }

    const results = await Promise.all(requests);
    expect(results.every((r) => r.status === 201)).toBe(true);

    for (const r of results) {
      if (r.orgLabel === 'a') {
        expect(r.body.organizationId).toBe(a.organizationId);
        expect(r.body.name).toMatch(/^A-Project-/);
      } else {
        expect(r.body.organizationId).toBe(b.organizationId);
        expect(r.body.name).toMatch(/^B-Project-/);
      }
    }

    // Final-state check: A's project list must be exactly A's 10 projects,
    // never any of B's, and vice versa.
    const listA = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/projects?limit=50`, headers: { cookie: a.cookie } });
    const listB = await app.inject({ method: 'GET', url: `/v1/organizations/${b.organizationId}/projects?limit=50`, headers: { cookie: b.cookie } });
    const namesA = (listA.json().items as Array<{ name: string }>).map((p) => p.name);
    const namesB = (listB.json().items as Array<{ name: string }>).map((p) => p.name);
    expect(namesA.every((n) => n.startsWith('A-Project-'))).toBe(true);
    expect(namesB.every((n) => n.startsWith('B-Project-'))).toBe(true);
    expect(namesA).toHaveLength(10);
    expect(namesB).toHaveLength(10);
  });

  it('concurrent cross-tenant reads against the same running instance stay isolated', async () => {
    const a = await createOwner('conc-read-a');
    const b = await createOwner('conc-read-b');
    const aProjectRes = await app.inject({ method: 'POST', url: `/v1/organizations/${a.organizationId}/projects`, headers: { cookie: a.cookie, origin: TRUSTED_ORIGIN }, payload: { name: 'A Only' } });
    const bProjectRes = await app.inject({ method: 'POST', url: `/v1/organizations/${b.organizationId}/projects`, headers: { cookie: b.cookie, origin: TRUSTED_ORIGIN }, payload: { name: 'B Only' } });
    const aProjectId = aProjectRes.json().id as string;
    const bProjectId = bProjectRes.json().id as string;

    const [crossAtoB, crossBtoA, okA, okB] = await Promise.all([
      app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/projects/${bProjectId}`, headers: { cookie: a.cookie } }),
      app.inject({ method: 'GET', url: `/v1/organizations/${b.organizationId}/projects/${aProjectId}`, headers: { cookie: b.cookie } }),
      app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/projects/${aProjectId}`, headers: { cookie: a.cookie } }),
      app.inject({ method: 'GET', url: `/v1/organizations/${b.organizationId}/projects/${bProjectId}`, headers: { cookie: b.cookie } }),
    ]);

    expect(crossAtoB.statusCode).toBe(404);
    expect(crossBtoA.statusCode).toBe(404);
    expect(okA.statusCode).toBe(200);
    expect(okB.statusCode).toBe(200);
  });
});
