import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createDbClient, type DbClient } from '../../src/db/client.js';
import { env } from '../../src/config/env.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { truncateAll } from './helpers.js';
import { member as memberTable, auditEvents } from '../../src/db/schema.js';
import { createPostgresAuditRepository } from '../../src/repositories/postgres/audit-repository.js';

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

async function createOrgFixture(label: string) {
  const ownerEmail = `owner-${label}@example.com`;
  const ownerSignUp = await auth.api.signUpEmail({ body: { email: ownerEmail, name: `Owner ${label}`, password: PASSWORD } });
  const org = await auth.api.createOrganization({ body: { name: `Org ${label}`, slug: `audit-org-${label}-${Date.now()}`, userId: ownerSignUp.user.id } });
  if (!org) throw new Error('org create failed');
  const existing = await dbClient.db.query.member.findFirst({ where: and(eq(memberTable.organizationId, org.id), eq(memberTable.userId, ownerSignUp.user.id)) });
  if (existing) {
    await dbClient.db.update(memberTable).set({ role: 'owner' }).where(eq(memberTable.id, existing.id));
  } else {
    await dbClient.db.insert(memberTable).values({ id: `mem_${ownerSignUp.user.id}_${org.id}`, organizationId: org.id, userId: ownerSignUp.user.id, role: 'owner', createdAt: new Date() });
  }
  return { organizationId: org.id, ownerUserId: ownerSignUp.user.id, ownerCookie: await loginCookie(ownerEmail, PASSWORD) };
}

async function auditRowsFor(organizationId: string, action: string) {
  const rows = await dbClient.db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, organizationId), eq(auditEvents.action, action as never)));
  return rows;
}

describe('audit_events: transactional wiring', () => {
  it('api key create/revoke/rotate each write exactly one audit row', async () => {
    const a = await createOrgFixture('key-flow');
    const projectRes = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${a.organizationId}/projects`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      payload: { name: 'P' },
    });
    const project = projectRes.json() as { id: string };

    const createRes = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      payload: { name: 'K' },
    });
    const key = createRes.json() as { id: string };

    const createdRows = await auditRowsFor(a.organizationId, 'api_key.created');
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0]!.actorUserId).toBe(a.ownerUserId);
    expect(createdRows[0]!.actorApiKeyId).toBeNull();
    expect(createdRows[0]!.targetId).toBe(key.id);
    expect(createdRows[0]!.metadata).toEqual({ apiKeyName: 'K', apiKeyPrefix: 'pr_live_' });
    // apiKeyPrefix ("pr_live_") is a fixed constant, not a secret — but the
    // full plaintext key (prefix + random secret) must never appear.
    const createdRowFullText = JSON.stringify(createdRows[0]);
    expect(createdRowFullText).not.toMatch(/pr_live_[A-Za-z0-9_-]{20,}/);

    const rotateRes = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys/${key.id}/rotate`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
    });
    const rotated = rotateRes.json() as { id: string };
    const rotatedRows = await auditRowsFor(a.organizationId, 'api_key.rotated');
    expect(rotatedRows).toHaveLength(1);
    expect(rotatedRows[0]!.targetId).toBe(rotated.id);

    const revokeRes = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys/${rotated.id}`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
    });
    expect(revokeRes.statusCode).toBe(200);
    const revokedRows = await auditRowsFor(a.organizationId, 'api_key.revoked');
    expect(revokedRows).toHaveLength(1);
    expect(revokedRows[0]!.targetId).toBe(rotated.id);
  });

  it('invitation create/cancel and member role-change/remove each write exactly one audit row', async () => {
    const a = await createOrgFixture('invite-flow');

    const inviteRes = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${a.organizationId}/invitations`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      payload: { email: 'invitee@example.com', role: 'member' },
    });
    const invite = inviteRes.json() as { id: string };
    const createdRows = await auditRowsFor(a.organizationId, 'organization.invitation.created');
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0]!.targetId).toBe(invite.id);
    // Invited email must never appear in audit metadata.
    expect(JSON.stringify(createdRows[0]!.metadata)).not.toContain('invitee@example.com');

    const cancelRes = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${a.organizationId}/invitations/${invite.id}`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
    });
    expect(cancelRes.statusCode).toBe(200);
    const cancelledRows = await auditRowsFor(a.organizationId, 'organization.invitation.cancelled');
    expect(cancelledRows).toHaveLength(1);

    // Add a plain member directly (bypassing accept-invitation email flow)
    // to exercise role-change/remove.
    const plainSignUp = await auth.api.signUpEmail({ body: { email: 'plain@example.com', name: 'Plain', password: PASSWORD } });
    const memberRow = await dbClient.db
      .insert(memberTable)
      .values({ id: `mem_${plainSignUp.user.id}_${a.organizationId}`, organizationId: a.organizationId, userId: plainSignUp.user.id, role: 'member', createdAt: new Date() })
      .returning();
    const memberId = memberRow[0]!.id;

    const roleChangeRes = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${a.organizationId}/members/${memberId}`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      payload: { role: 'admin' },
    });
    expect(roleChangeRes.statusCode).toBe(200);
    const roleChangedRows = await auditRowsFor(a.organizationId, 'organization.member.role_changed');
    expect(roleChangedRows).toHaveLength(1);
    expect(roleChangedRows[0]!.metadata).toEqual({ roleBefore: 'member', roleAfter: 'admin' });

    const removeRes = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${a.organizationId}/members/${memberId}`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
    });
    expect(removeRes.statusCode).toBe(200);
    const removedRows = await auditRowsFor(a.organizationId, 'organization.member.removed');
    expect(removedRows).toHaveLength(1);
  });

  it('invitation acceptance writes an audit row attributed to the accepting user', async () => {
    const a = await createOrgFixture('accept-flow');
    const inviteRes = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${a.organizationId}/invitations`,
      headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
      payload: { email: 'newperson@example.com', role: 'member' },
    });
    const { createInvitationService } = await import('../../src/services/invitation-service.js');
    void createInvitationService;
    const inviteBody = inviteRes.json() as { token: string };

    const acceptRes = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/accept',
      payload: { token: inviteBody.token, name: 'New Person', password: 'a-decent-length-password' },
    });
    expect(acceptRes.statusCode).toBe(200);

    const acceptedRows = await auditRowsFor(a.organizationId, 'organization.invitation.accepted');
    expect(acceptedRows).toHaveLength(1);
    expect(acceptedRows[0]!.actorUserId).not.toBeNull();
    expect(acceptedRows[0]!.actorApiKeyId).toBeNull();
  });

  it('a failed audit insert rolls back the paired mutation (metadata allowlist violation forces the failure)', async () => {
    // createApiKeyForProject builds metadata from a fixed allowlisted set
    // (apiKeyName/apiKeyPrefix) so it can't normally fail — this test
    // instead exercises the guarantee at the repository level directly:
    // an audit insert inside the SAME transaction as the mutation, when
    // forced to throw (simulated here via an invalid organizationId that
    // violates the audit_events FK), leaves no key row behind either.
    const a = await createOrgFixture('rollback-flow');
    const { createApiKeyRepository } = await import('../../src/repositories/postgres/api-key-repository.js');
    const repo = createApiKeyRepository(dbClient.db);
    await expect(
      repo.createApiKeyForProject({
        organizationId: 'org_does_not_exist',
        name: 'X',
        prefix: 'pr_live_',
        expiresAt: new Date(Date.now() + 86400000),
        rateLimitMax: 120,
        rateLimitTimeWindowMs: 60000,
        metadata: { projectId: '00000000-0000-0000-0000-000000000000', createdByUserId: a.ownerUserId, revokedAt: null, rotatedFromKeyId: null, rotatedToKeyId: null },
        requestId: null,
      }),
    ).rejects.toThrow();

    const { apikey } = await import('../../src/db/schema.js');
    const leftoverKeys = await dbClient.db.select().from(apikey).where(eq(apikey.referenceId, 'org_does_not_exist'));
    expect(leftoverKeys).toHaveLength(0);
  });

  it('listAuditEventsForOrganization is tenant-isolated and stably ordered', async () => {
    const a = await createOrgFixture('list-a');
    const b = await createOrgFixture('list-b');
    const projectA = (
      await app.inject({ method: 'POST', url: `/v1/organizations/${a.organizationId}/projects`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN }, payload: { name: 'PA' } })
    ).json() as { id: string };
    const projectB = (
      await app.inject({ method: 'POST', url: `/v1/organizations/${b.organizationId}/projects`, headers: { cookie: b.ownerCookie, origin: TRUSTED_ORIGIN }, payload: { name: 'PB' } })
    ).json() as { id: string };

    await app.inject({ method: 'POST', url: `/v1/organizations/${a.organizationId}/projects/${projectA.id}/api-keys`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN }, payload: { name: 'KA1' } });
    await app.inject({ method: 'POST', url: `/v1/organizations/${a.organizationId}/projects/${projectA.id}/api-keys`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN }, payload: { name: 'KA2' } });
    await app.inject({ method: 'POST', url: `/v1/organizations/${b.organizationId}/projects/${projectB.id}/api-keys`, headers: { cookie: b.ownerCookie, origin: TRUSTED_ORIGIN }, payload: { name: 'KB1' } });

    const repo = createPostgresAuditRepository(dbClient.db);
    const aRows = await repo.listAuditEventsForOrganization({ organizationId: a.organizationId, action: 'api_key.created', limit: 50 });
    expect(aRows).toHaveLength(2);
    expect(aRows.every((r) => r.organizationId === a.organizationId)).toBe(true);
    // createdAt DESC, id DESC
    for (let i = 1; i < aRows.length; i++) {
      const prev = aRows[i - 1]!;
      const curr = aRows[i]!;
      expect(prev.createdAt.getTime() >= curr.createdAt.getTime()).toBe(true);
    }

    const bRows = await repo.listAuditEventsForOrganization({ organizationId: b.organizationId, action: 'api_key.created', limit: 50 });
    expect(bRows).toHaveLength(1);
    expect(bRows[0]!.organizationId).toBe(b.organizationId);
  });
});
