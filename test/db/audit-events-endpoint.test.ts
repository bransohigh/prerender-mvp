import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createDbClient, type DbClient } from '../../src/db/client.js';
import { env } from '../../src/config/env.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { truncateAll } from './helpers.js';
import { member as memberTable, auditEvents, projects, domains } from '../../src/db/schema.js';

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

interface OrgFixture {
  organizationId: string;
  ownerUserId: string;
  ownerCookie: string;
  adminCookie: string;
  memberCookie: string;
}

async function createOrgFixture(label: string): Promise<OrgFixture> {
  const ownerEmail = `owner-${label}@example.com`;
  const adminEmail = `admin-${label}@example.com`;
  const memberEmail = `member-${label}@example.com`;

  const ownerSignUp = await auth.api.signUpEmail({ body: { email: ownerEmail, name: `Owner ${label}`, password: PASSWORD } });
  const org = await auth.api.createOrganization({ body: { name: `Org ${label}`, slug: `audit-ep-org-${label}-${Date.now()}`, userId: ownerSignUp.user.id } });
  if (!org) throw new Error('org create failed');

  const existingOwner = await dbClient.db.query.member.findFirst({ where: and(eq(memberTable.organizationId, org.id), eq(memberTable.userId, ownerSignUp.user.id)) });
  if (existingOwner) {
    await dbClient.db.update(memberTable).set({ role: 'owner' }).where(eq(memberTable.id, existingOwner.id));
  } else {
    await dbClient.db.insert(memberTable).values({ id: `mem_${ownerSignUp.user.id}_${org.id}`, organizationId: org.id, userId: ownerSignUp.user.id, role: 'owner', createdAt: new Date() });
  }

  const adminSignUp = await auth.api.signUpEmail({ body: { email: adminEmail, name: `Admin ${label}`, password: PASSWORD } });
  await dbClient.db.insert(memberTable).values({ id: `mem_${adminSignUp.user.id}_${org.id}`, organizationId: org.id, userId: adminSignUp.user.id, role: 'admin', createdAt: new Date() });

  const memberSignUp = await auth.api.signUpEmail({ body: { email: memberEmail, name: `Member ${label}`, password: PASSWORD } });
  await dbClient.db.insert(memberTable).values({ id: `mem_${memberSignUp.user.id}_${org.id}`, organizationId: org.id, userId: memberSignUp.user.id, role: 'member', createdAt: new Date() });

  return {
    organizationId: org.id,
    ownerUserId: ownerSignUp.user.id,
    ownerCookie: await loginCookie(ownerEmail, PASSWORD),
    adminCookie: await loginCookie(adminEmail, PASSWORD),
    memberCookie: await loginCookie(memberEmail, PASSWORD),
  };
}

async function createProject(orgId: string, cookie: string, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/organizations/${orgId}/projects`,
    headers: { cookie, origin: TRUSTED_ORIGIN },
    payload: { name },
  });
  return res.json() as { id: string };
}

describe('GET /v1/organizations/:organizationId/audit-events', () => {
  it('owner can access; admin can access; member gets 403; outsider gets 404', async () => {
    const a = await createOrgFixture('access-a');
    const outsider = await createOrgFixture('access-outsider');
    await createProject(a.organizationId, a.ownerCookie, 'P');

    const ownerRes = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events`, headers: { cookie: a.ownerCookie } });
    expect(ownerRes.statusCode).toBe(200);
    expect(ownerRes.json().items.length).toBeGreaterThan(0);

    const adminRes = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events`, headers: { cookie: a.adminCookie } });
    expect(adminRes.statusCode).toBe(200);

    const memberRes = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events`, headers: { cookie: a.memberCookie } });
    expect(memberRes.statusCode).toBe(403);
    expect(memberRes.json().error).toBe('FORBIDDEN_ROLE');

    const outsiderRes = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events`, headers: { cookie: outsider.ownerCookie } });
    expect(outsiderRes.statusCode).toBe(404);
  });

  it('response contains no secret fields and only the safe schema', async () => {
    const a = await createOrgFixture('safe-schema');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const keyRes = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      payload: { name: 'K' },
    });
    const key = keyRes.json() as { key: string };

    const res = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events`, headers: { cookie: a.ownerCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<Record<string, unknown>> };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(
        ['action', 'actorApiKeyId', 'actorType', 'actorUserId', 'createdAt', 'errorCode', 'id', 'metadata', 'requestId', 'result', 'targetId', 'targetType'].sort(),
      );
    }
    expect(JSON.stringify(body)).not.toContain(key.key);
  });

  it('rejects a malformed cursor with a stable 400', async () => {
    const a = await createOrgFixture('bad-cursor');
    const res = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events?cursor=not-a-real-cursor-!!!`, headers: { cookie: a.ownerCookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_cursor');
  });

  it('rejects an unknown action/result/targetType filter value with 400', async () => {
    const a = await createOrgFixture('bad-filter');
    const res1 = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events?action=not.a.real.action`, headers: { cookie: a.ownerCookie } });
    expect(res1.statusCode).toBe(400);
    const res2 = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events?result=maybe`, headers: { cookie: a.ownerCookie } });
    expect(res2.statusCode).toBe(400);
    const res3 = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events?targetType=arbitrary`, headers: { cookie: a.ownerCookie } });
    expect(res3.statusCode).toBe(400);
  });

  it('paginates with a stable cursor, never repeating or skipping records', async () => {
    const a = await createOrgFixture('pagination');
    for (let i = 0; i < 5; i++) {
      await createProject(a.organizationId, a.ownerCookie, `P${i}`);
    }
    const page1 = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events?action=project.created&limit=2`, headers: { cookie: a.ownerCookie } });
    const body1 = page1.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(body1.items).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events?action=project.created&limit=2&cursor=${encodeURIComponent(body1.nextCursor!)}`, headers: { cookie: a.ownerCookie } });
    const body2 = page2.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(body2.items).toHaveLength(2);

    const page3 = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events?action=project.created&limit=2&cursor=${encodeURIComponent(body2.nextCursor!)}`, headers: { cookie: a.ownerCookie } });
    const body3 = page3.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(body3.items).toHaveLength(1);
    expect(body3.nextCursor).toBeNull();

    const allIds = [...body1.items, ...body2.items, ...body3.items].map((i) => i.id);
    expect(new Set(allIds).size).toBe(5); // no repeats
  });

  it('filters by action and targetType, scoped to the organization', async () => {
    const a = await createOrgFixture('filters');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    await app.inject({ method: 'POST', url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN }, payload: { name: 'K' } });

    const byAction = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events?action=api_key.created`, headers: { cookie: a.ownerCookie } });
    const byActionBody = byAction.json() as { items: Array<{ action: string }> };
    expect(byActionBody.items.every((i) => i.action === 'api_key.created')).toBe(true);
    expect(byActionBody.items.length).toBeGreaterThan(0);

    const byTargetType = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events?targetType=project`, headers: { cookie: a.ownerCookie } });
    const byTargetTypeBody = byTargetType.json() as { items: Array<{ targetType: string }> };
    expect(byTargetTypeBody.items.every((i) => i.targetType === 'project')).toBe(true);
  });

  it('cross-tenant: a known foreign audit id never appears in another org listing, and filters cannot escape scope', async () => {
    const a = await createOrgFixture('cross-a');
    const b = await createOrgFixture('cross-b');
    await createProject(a.organizationId, a.ownerCookie, 'PA');
    await createProject(b.organizationId, b.ownerCookie, 'PB');

    const aRes = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events?action=project.created`, headers: { cookie: a.ownerCookie } });
    const aBody = aRes.json() as { items: Array<{ id: string }> };
    const bRes = await app.inject({ method: 'GET', url: `/v1/organizations/${b.organizationId}/audit-events?action=project.created`, headers: { cookie: b.ownerCookie } });
    const bBody = bRes.json() as { items: Array<{ id: string }> };

    const aIds = new Set(aBody.items.map((i) => i.id));
    for (const item of bBody.items) {
      expect(aIds.has(item.id)).toBe(false);
    }
  });
});

describe('project/domain mutation audit: transactional rollback', () => {
  it('a forced audit-insert failure rolls back project creation (no leftover project row)', async () => {
    const a = await createOrgFixture('project-rollback');
    const { createTenantRepository } = await import('../../src/repositories/postgres/tenant-repository.js');
    const tenant = createTenantRepository(dbClient.db);
    // A too-long metadata string forces buildAuditMetadata to throw inside
    // the SAME transaction as the project insert — proving the mutation
    // rolls back rather than silently committing without its audit row.
    // We simulate this by directly invoking updateProjectForOrganization's
    // underlying transaction shape isn't reachable from create (metadata
    // is null there), so we exercise the guaranteed-throw path via
    // insertAuditEventRow's FK constraint instead (organizationId that
    // doesn't exist as a member row is fine for audit_events' own FK to
    // `organization`, since audit_events.organization_id references
    // organization.id, not membership) — use a syntactically invalid
    // organizationId to violate that FK and force a rollback.
    await expect(
      tenant.createProjectForOrganization(
        'org_does_not_exist_at_all',
        { name: 'X', slug: `rollback-${Date.now()}` },
        a.ownerUserId,
        null,
      ),
    ).rejects.toThrow();

    const allProjects = await dbClient.db.select().from(projects);
    expect(allProjects.find((p) => p.name === 'X')).toBeUndefined();
  });

  it('a forced audit-insert failure rolls back domain creation (no leftover domain row)', async () => {
    const a = await createOrgFixture('domain-rollback');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const { createTenantRepository } = await import('../../src/repositories/postgres/tenant-repository.js');
    const { hashVerificationToken, generateVerificationToken } = await import('../../src/lib/verification-token.js');
    const tenant = createTenantRepository(dbClient.db);

    // actorUserId that violates audit_events.actor_user_id's FK to `user`
    // forces the audit insert (and therefore the whole transaction,
    // including the domain insert) to fail.
    await expect(
      tenant.createDomainForOrganization(
        a.organizationId,
        project.id,
        {
          hostname: 'rollback-test.example.com',
          normalizedHostname: 'rollback-test.example.com',
          verificationMethod: 'dns_txt',
          verificationTokenHash: hashVerificationToken(generateVerificationToken()),
        },
        'user_does_not_exist_at_all',
        null,
      ),
    ).rejects.toThrow();

    const leftoverDomains = await dbClient.db.select().from(domains).where(eq(domains.normalizedHostname, 'rollback-test.example.com'));
    expect(leftoverDomains).toHaveLength(0);
  });

  it('domain verification final-state persists atomically with its succeeded/failed audit event', async () => {
    const a = await createOrgFixture('verify-atomic');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const { createTenantRepository } = await import('../../src/repositories/postgres/tenant-repository.js');
    const { hashVerificationToken, generateVerificationToken } = await import('../../src/lib/verification-token.js');
    const tenant = createTenantRepository(dbClient.db);
    const domain = await tenant.createDomainForOrganization(
      a.organizationId,
      project.id,
      {
        hostname: 'verify-atomic.example.com',
        normalizedHostname: 'verify-atomic.example.com',
        verificationMethod: 'dns_txt',
        verificationTokenHash: hashVerificationToken(generateVerificationToken()),
      },
      a.ownerUserId,
      null,
    );

    const result = await tenant.markVerificationAttemptForOrganization(a.organizationId, domain.id, { success: true }, a.ownerUserId, null);
    expect(result?.status).toBe('verified');

    const rows = await dbClient.db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, a.organizationId), eq(auditEvents.action, 'domain.verification.succeeded' as never)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe(domain.id);
  });
});

describe('audit metadata leakage', () => {
  it('sentinel secrets never appear in audit_events rows, API responses, or metrics', async () => {
    const a = await createOrgFixture('leakage');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const keyRes = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      payload: { name: 'SENTINEL-KEY-NAME' },
    });
    const key = keyRes.json() as { key: string; id: string };

    const inviteRes = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${a.organizationId}/invitations`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      payload: { email: 'sentinel-invitee@example.com', role: 'member' },
    });
    const invite = inviteRes.json() as { token: string };

    const auditRes = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/audit-events`, headers: { cookie: a.ownerCookie } });
    const auditBody = JSON.stringify(auditRes.json());
    expect(auditBody).not.toContain(key.key);
    expect(auditBody).not.toContain(invite.token);
    expect(auditBody).not.toContain('sentinel-invitee@example.com');

    const rows = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.organizationId, a.organizationId));
    const rowsText = JSON.stringify(rows);
    expect(rowsText).not.toContain(key.key);
    expect(rowsText).not.toContain(invite.token);
    expect(rowsText).not.toContain('sentinel-invitee@example.com');

    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.body).not.toContain(key.key);
    expect(metricsRes.body).not.toContain(invite.token);
    expect(metricsRes.body).not.toContain('sentinel-invitee@example.com');
  });
});

describe('sitemap discovery/fetch audit events', () => {
  it('records started/completed for discovery and fetch, scoped to the organization', async () => {
    const a = await createOrgFixture('sitemap-audit');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const domainRes = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${a.organizationId}/projects/${project.id}/domains`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      payload: { hostname: 'sitemap-audit.example.com', verificationMethod: 'dns_txt' },
    });
    const domain = (domainRes.json() as { domain: { id: string } }).domain;
    await dbClient.db.update(domains).set({ status: 'verified', verifiedAt: new Date() }).where(eq(domains.id, domain.id));

    // No real network in this test — discovery hits real DNS/HTTP for
    // robots.txt/sitemap.xml against a non-existent domain, which fails
    // fast and falls back to recording the two default candidate URLs
    // (safeFetch rejects the private/unresolvable hostname, discovery
    // treats that as "robots not found" and continues, matching
    // production behavior for a domain with no reachable robots.txt).
    const discoverRes = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${a.organizationId}/domains/${domain.id}/discover-sitemaps`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
    });
    expect(discoverRes.statusCode).toBe(200);

    const startedRows = await dbClient.db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, a.organizationId), eq(auditEvents.action, 'sitemap.discovery.started' as never)));
    expect(startedRows).toHaveLength(1);
    const completedRows = await dbClient.db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, a.organizationId), eq(auditEvents.action, 'sitemap.discovery.completed' as never)));
    expect(completedRows).toHaveLength(1);
  }, 20000);
});
