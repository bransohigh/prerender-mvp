import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Mocked (module-level, hoisted) so a single test can force
// crypto.randomUUID() to return a specific value for exactly one call,
// simulating a real Postgres primary-key collision inside the rotation
// transaction — everything else (randomBytes, etc.) passes through
// unmodified.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createDbClient, type DbClient } from '../../src/db/client.js';
import { env } from '../../src/config/env.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { truncateAll } from './helpers.js';
import { member as memberTable, apikey as apikeyTable } from '../../src/db/schema.js';
import { createTenantRepository } from '../../src/repositories/postgres/tenant-repository.js';
import { createApiKeyRepository } from '../../src/repositories/postgres/api-key-repository.js';
import { createApiKeyService } from '../../src/services/api-key-service.js';

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
  ownerCookie: string;
  adminCookie: string;
  memberCookie: string;
}

async function createOrgFixture(label: string): Promise<OrgFixture> {
  const ownerEmail = `owner-${label}@example.com`;
  const adminEmail = `admin-${label}@example.com`;
  const memberEmail = `member-${label}@example.com`;

  const ownerSignUp = await auth.api.signUpEmail({ body: { email: ownerEmail, name: `Owner ${label}`, password: PASSWORD } });
  const org = await auth.api.createOrganization({ body: { name: `Org ${label}`, slug: `apikey-org-${label}-${Date.now()}`, userId: ownerSignUp.user.id } });
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

async function createKeyHttp(orgId: string, projectId: string, cookie: string, payload: Record<string, unknown> = { name: 'Test Key' }) {
  return app.inject({
    method: 'POST',
    url: `/v1/organizations/${orgId}/projects/${projectId}/api-keys`,
    headers: { cookie, origin: TRUSTED_ORIGIN },
    payload,
  });
}

describe('project-scoped render API keys', () => {
  it('returns the plaintext key only in the creation response', async () => {
    const a = await createOrgFixture('create-once');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const res = await createKeyHttp(a.organizationId, project.id, a.ownerCookie);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.key).toBe('string');
    expect(body.key.startsWith('pr_live_')).toBe(true);

    const listRes = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys`, headers: { cookie: a.ownerCookie } });
    const listBody = listRes.json();
    expect(JSON.stringify(listBody)).not.toContain(body.key);
    expect(listBody.items[0]).not.toHaveProperty('key');
    expect(listBody.items[0]).not.toHaveProperty('hash');
  });

  it('the stored database value is not the plaintext key', async () => {
    const a = await createOrgFixture('storage');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const res = await createKeyHttp(a.organizationId, project.id, a.ownerCookie);
    const plaintext = res.json().key as string;

    const rows = await dbClient.db.select().from(apikeyTable).where(eq(apikeyTable.referenceId, a.organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).not.toBe(plaintext);
    expect(rows[0]!.key.length).toBeGreaterThan(10);
  });

  it('owner and admin can create; member is forbidden', async () => {
    const a = await createOrgFixture('create-role');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');

    expect((await createKeyHttp(a.organizationId, project.id, a.ownerCookie, { name: 'Owner Key' })).statusCode).toBe(201);
    expect((await createKeyHttp(a.organizationId, project.id, a.adminCookie, { name: 'Admin Key' })).statusCode).toBe(201);
    expect((await createKeyHttp(a.organizationId, project.id, a.memberCookie, { name: 'Member Key' })).statusCode).toBe(403);
  });

  it('cross-tenant project id returns 404', async () => {
    const a = await createOrgFixture('cross-a');
    const b = await createOrgFixture('cross-b');
    const bProject = await createProject(b.organizationId, b.ownerCookie, 'B Project');

    const res = await createKeyHttp(a.organizationId, bProject.id, a.ownerCookie);
    expect(res.statusCode).toBe(404);
  });

  it('validates name and expiresInDays bounds', async () => {
    const a = await createOrgFixture('validate');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');

    const emptyName = await createKeyHttp(a.organizationId, project.id, a.ownerCookie, { name: '' });
    expect(emptyName.statusCode).toBe(400);

    const tooLongExpiry = await createKeyHttp(a.organizationId, project.id, a.ownerCookie, { name: 'X', expiresInDays: 400 });
    expect(tooLongExpiry.statusCode).toBe(400);

    const zeroExpiry = await createKeyHttp(a.organizationId, project.id, a.ownerCookie, { name: 'X', expiresInDays: 0 });
    expect(zeroExpiry.statusCode).toBe(400);
  });

  it('revoke makes the key immediately invalid via auth.api.verifyApiKey', async () => {
    const a = await createOrgFixture('revoke');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const created = (await createKeyHttp(a.organizationId, project.id, a.ownerCookie)).json();

    const beforeRevoke = await auth.api.verifyApiKey({ body: { key: created.key } });
    expect(beforeRevoke.valid).toBe(true);

    const revokeRes = await app.inject({ method: 'DELETE', url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys/${created.id}`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN } });
    expect(revokeRes.statusCode).toBe(200);

    const afterRevoke = await auth.api.verifyApiKey({ body: { key: created.key } });
    expect(afterRevoke.valid).toBe(false);
  });

  it('repeated revoke is a stable conflict, not a silent success', async () => {
    const a = await createOrgFixture('revoke-repeat');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const created = (await createKeyHttp(a.organizationId, project.id, a.ownerCookie)).json();

    await app.inject({ method: 'DELETE', url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys/${created.id}`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN } });
    const second = await app.inject({ method: 'DELETE', url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys/${created.id}`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('API_KEY_REVOKED');
  });

  it('revoke/list of a cross-tenant key id returns 404', async () => {
    const a = await createOrgFixture('revoke-cross-a');
    const b = await createOrgFixture('revoke-cross-b');
    const bProject = await createProject(b.organizationId, b.ownerCookie, 'B Project');
    const bKey = (await createKeyHttp(b.organizationId, bProject.id, b.ownerCookie)).json();

    const res = await app.inject({ method: 'DELETE', url: `/v1/organizations/${a.organizationId}/projects/${bProject.id}/api-keys/${bKey.id}`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN } });
    expect(res.statusCode).toBe(404);
  });

  it('rotate invalidates the old key and the new key works', async () => {
    const a = await createOrgFixture('rotate');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const original = (await createKeyHttp(a.organizationId, project.id, a.ownerCookie)).json();

    const rotateRes = await app.inject({ method: 'POST', url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys/${original.id}/rotate`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN } });
    expect(rotateRes.statusCode).toBe(201);
    const rotated = rotateRes.json();
    expect(rotated.key).not.toBe(original.key);

    const oldVerify = await auth.api.verifyApiKey({ body: { key: original.key } });
    expect(oldVerify.valid).toBe(false);

    const newVerify = await auth.api.verifyApiKey({ body: { key: rotated.key } });
    expect(newVerify.valid).toBe(true);
  });

  it('cross-project key management (rotate on the wrong project) returns 404', async () => {
    const a = await createOrgFixture('rotate-cross');
    const projectA = await createProject(a.organizationId, a.ownerCookie, 'A');
    const projectB = await createProject(a.organizationId, a.ownerCookie, 'B');
    const keyA = (await createKeyHttp(a.organizationId, projectA.id, a.ownerCookie)).json();

    const res = await app.inject({ method: 'POST', url: `/v1/organizations/${a.organizationId}/projects/${projectB.id}/api-keys/${keyA.id}/rotate`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN } });
    expect(res.statusCode).toBe(404);
  });

  it('key expiration: an expired key fails verification', async () => {
    const a = await createOrgFixture('expiry');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const created = (await createKeyHttp(a.organizationId, project.id, a.ownerCookie, { name: 'Short', expiresInDays: 1 })).json();

    // Force the row into the past directly (no need to wait a real day).
    await dbClient.db.update(apikeyTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apikeyTable.id, created.id));

    const verify = await auth.api.verifyApiKey({ body: { key: created.key } });
    expect(verify.valid).toBe(false);
  });

  it('concurrent rotation: exactly one attempt succeeds, exactly one successor exists and verifies, original is invalid', async () => {
    const a = await createOrgFixture('concurrent-rotate');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const created = (await createKeyHttp(a.organizationId, project.id, a.ownerCookie)).json();

    const ATTEMPTS = 8;
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () =>
        app.inject({
          method: 'POST',
          url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys/${created.id}/rotate`,
          headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN },
        }),
      ),
    );

    const succeeded = results.filter((r) => r.statusCode === 201);
    const failed = results.filter((r) => r.statusCode !== 201);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(ATTEMPTS - 1);
    // Every rejected concurrent attempt gets a stable conflict code, not a
    // generic/ambiguous error.
    for (const res of failed) {
      expect(res.statusCode).toBe(409);
      expect(['API_KEY_REVOKED']).toContain(res.json().error);
    }

    // Exactly one successor row references this key as rotatedFromKeyId.
    const allKeysForProject = await createApiKeyRepository(dbClient.db).listApiKeysForProject(a.organizationId, project.id);
    const successors = allKeysForProject.filter((k) => k.metadata?.rotatedFromKeyId === created.id);
    expect(successors).toHaveLength(1);
    expect(successors[0]!.enabled).toBe(true);

    // No additional active keys exist beyond the original (now revoked)
    // and its single successor.
    expect(allKeysForProject).toHaveLength(2);
    const activeKeys = allKeysForProject.filter((k) => k.enabled);
    expect(activeKeys).toHaveLength(1);
    expect(activeKeys[0]!.id).toBe(successors[0]!.id);

    const successorPlaintext = succeeded[0]!.json().key as string;
    const successorVerify = await auth.api.verifyApiKey({ body: { key: successorPlaintext } });
    expect(successorVerify.valid).toBe(true);

    const originalVerify = await auth.api.verifyApiKey({ body: { key: created.key } });
    expect(originalVerify.valid).toBe(false);
  });

  it('rotating an already-revoked key is rejected without creating a successor', async () => {
    const a = await createOrgFixture('rotate-revoked');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const created = (await createKeyHttp(a.organizationId, project.id, a.ownerCookie)).json();

    await app.inject({ method: 'DELETE', url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys/${created.id}`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN } });

    const rotateRes = await app.inject({ method: 'POST', url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys/${created.id}/rotate`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN } });
    expect(rotateRes.statusCode).toBe(409);
    expect(rotateRes.json().error).toBe('API_KEY_REVOKED');

    const allKeysForProject = await createApiKeyRepository(dbClient.db).listApiKeysForProject(a.organizationId, project.id);
    expect(allKeysForProject).toHaveLength(1);
  });

  it('a failed rotation transaction leaves the original key valid without a repair query', async () => {
    const a = await createOrgFixture('rollback');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const created = (await createKeyHttp(a.organizationId, project.id, a.ownerCookie)).json();

    // Force the transaction's INSERT of the successor row to fail with a
    // real Postgres primary-key violation: pre-insert a decoy key sharing
    // the id the rotation would otherwise generate, by making
    // crypto.randomUUID deterministic for exactly the next call inside the
    // transaction. This exercises Postgres's own automatic rollback, not
    // an app-level catch/repair step.
    const nodeCrypto = await import('node:crypto');
    const collidingId = crypto.randomUUID();
    await dbClient.db.insert(apikeyTable).values({
      id: collidingId,
      configId: 'default',
      name: 'Decoy',
      prefix: 'pr_live_',
      start: 'pr_live',
      key: 'decoy-hash-value-not-a-real-key',
      referenceId: a.organizationId,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: JSON.stringify({ projectId: project.id, createdByUserId: 'nobody', revokedAt: null, rotatedFromKeyId: null, rotatedToKeyId: null }),
    });

    vi.mocked(nodeCrypto.randomUUID).mockReturnValueOnce(collidingId as `${string}-${string}-${string}-${string}-${string}`);
    try {
      const tenant = createTenantRepository(dbClient.db);
      const apiKeyRepo = createApiKeyRepository(dbClient.db);
      const service = createApiKeyService(tenant, apiKeyRepo);
      await expect(service.rotateKey(a.organizationId, project.id, created.id, 'someone', null)).rejects.toThrow();
    } finally {
      vi.mocked(nodeCrypto.randomUUID).mockClear();
    }

    // No repair/restore query is issued anywhere in the code path above —
    // Postgres's own transaction rollback is what leaves this true.
    const afterFailure = await auth.api.verifyApiKey({ body: { key: created.key } });
    expect(afterFailure.valid).toBe(true);

    const row = await dbClient.db.select().from(apikeyTable).where(eq(apikeyTable.id, created.id)).then((r) => r[0]);
    expect(row?.enabled).toBe(true);
    const metadata = JSON.parse(row!.metadata!) as { revokedAt: string | null; rotatedToKeyId: string | null };
    expect(metadata.revokedAt).toBeNull();
    expect(metadata.rotatedToKeyId).toBeNull();
  });

  it('full key never appears in a metrics scrape', async () => {
    const a = await createOrgFixture('metrics-leak');
    const project = await createProject(a.organizationId, a.ownerCookie, 'P');
    const created = (await createKeyHttp(a.organizationId, project.id, a.ownerCookie)).json();

    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.body).not.toContain(created.key);
  });

  describe('malformed metadata fails closed', () => {
    async function insertRawKey(organizationId: string, metadataRaw: string | null): Promise<string> {
      const id = crypto.randomUUID();
      await dbClient.db.insert(apikeyTable).values({
        id,
        configId: 'default',
        name: 'Raw',
        prefix: 'pr_live_',
        start: 'pr_live',
        key: 'unused-hash-value',
        referenceId: organizationId,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: metadataRaw,
      });
      return id;
    }

    it('rejects a key with no metadata at all', async () => {
      const a = await createOrgFixture('meta-none');
      const project = await createProject(a.organizationId, a.ownerCookie, 'P');
      const keyId = await insertRawKey(a.organizationId, null);

      const repo = createApiKeyRepository(dbClient.db);
      expect(await repo.getApiKeyForProject(a.organizationId, project.id, keyId)).toBeNull();

      const listRes = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys`, headers: { cookie: a.ownerCookie } });
      expect((listRes.json().items as unknown[]).some((k) => (k as { id: string }).id === keyId)).toBe(false);
    });

    it('rejects a key with a non-JSON metadata string', async () => {
      const a = await createOrgFixture('meta-bad-json');
      const project = await createProject(a.organizationId, a.ownerCookie, 'P');
      const keyId = await insertRawKey(a.organizationId, 'not valid json {{{');

      const repo = createApiKeyRepository(dbClient.db);
      expect(await repo.getApiKeyForProject(a.organizationId, project.id, keyId)).toBeNull();
    });

    it('rejects a key whose metadata is a JSON array, not an object', async () => {
      const a = await createOrgFixture('meta-array');
      const project = await createProject(a.organizationId, a.ownerCookie, 'P');
      const keyId = await insertRawKey(a.organizationId, JSON.stringify([project.id]));

      const repo = createApiKeyRepository(dbClient.db);
      expect(await repo.getApiKeyForProject(a.organizationId, project.id, keyId)).toBeNull();
    });

    it('rejects a key whose metadata.projectId is not a UUID', async () => {
      const a = await createOrgFixture('meta-bad-project-id');
      const project = await createProject(a.organizationId, a.ownerCookie, 'P');
      const keyId = await insertRawKey(a.organizationId, JSON.stringify({ projectId: 'not-a-uuid' }));

      const repo = createApiKeyRepository(dbClient.db);
      expect(await repo.getApiKeyForProject(a.organizationId, project.id, keyId)).toBeNull();
    });

    it('rejects a key whose metadata.revokedAt is not a valid timestamp', async () => {
      const a = await createOrgFixture('meta-bad-revoked-at');
      const project = await createProject(a.organizationId, a.ownerCookie, 'P');
      const keyId = await insertRawKey(a.organizationId, JSON.stringify({ projectId: project.id, revokedAt: 'not-a-date' }));

      const repo = createApiKeyRepository(dbClient.db);
      expect(await repo.getApiKeyForProject(a.organizationId, project.id, keyId)).toBeNull();
    });

    it('rejects a key whose metadata.rotatedFromKeyId is not a valid id', async () => {
      const a = await createOrgFixture('meta-bad-rotated-from');
      const project = await createProject(a.organizationId, a.ownerCookie, 'P');
      const keyId = await insertRawKey(a.organizationId, JSON.stringify({ projectId: project.id, rotatedFromKeyId: '../../etc/passwd' }));

      const repo = createApiKeyRepository(dbClient.db);
      expect(await repo.getApiKeyForProject(a.organizationId, project.id, keyId)).toBeNull();
    });

    it('a malformed-metadata key cannot be revoked or rotated through the project route', async () => {
      const a = await createOrgFixture('meta-no-revoke');
      const project = await createProject(a.organizationId, a.ownerCookie, 'P');
      const keyId = await insertRawKey(a.organizationId, 'garbage');

      const revokeRes = await app.inject({ method: 'DELETE', url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys/${keyId}`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN } });
      expect(revokeRes.statusCode).toBe(404);

      const rotateRes = await app.inject({ method: 'POST', url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys/${keyId}/rotate`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN } });
      expect(rotateRes.statusCode).toBe(404);

      const row = await dbClient.db.select().from(apikeyTable).where(eq(apikeyTable.id, keyId)).then((r) => r[0]);
      expect(row?.enabled).toBe(true); // untouched
    });

    it('list/get responses never include raw metadata', async () => {
      const a = await createOrgFixture('meta-no-leak');
      const project = await createProject(a.organizationId, a.ownerCookie, 'P');
      await createKeyHttp(a.organizationId, project.id, a.ownerCookie);

      const listRes = await app.inject({ method: 'GET', url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys`, headers: { cookie: a.ownerCookie } });
      const body = listRes.json();
      for (const item of body.items) {
        expect(item).not.toHaveProperty('metadata');
        expect(item).not.toHaveProperty('createdByUserId');
      }
    });
  });

  describe('organization/project consistency', () => {
    it('the stored row has referenceId === organizationId and metadata.projectId === the scoped project', async () => {
      const a = await createOrgFixture('consistency-create');
      const project = await createProject(a.organizationId, a.ownerCookie, 'P');
      const created = (await createKeyHttp(a.organizationId, project.id, a.ownerCookie)).json();

      const row = await dbClient.db.select().from(apikeyTable).where(eq(apikeyTable.id, created.id)).then((r) => r[0]);
      expect(row?.referenceId).toBe(a.organizationId);
      const metadata = JSON.parse(row!.metadata!) as { projectId: string; createdByUserId: string };
      expect(metadata.projectId).toBe(project.id);
    });

    it('createdByUserId on the stored row is the authenticated actor who performed the operation', async () => {
      const a = await createOrgFixture('consistency-actor');
      const project = await createProject(a.organizationId, a.ownerCookie, 'P');
      const created = (await createKeyHttp(a.organizationId, project.id, a.adminCookie)).json();

      const session = await auth.api.getSession({ headers: new Headers({ cookie: a.adminCookie }) });
      const row = await dbClient.db.select().from(apikeyTable).where(eq(apikeyTable.id, created.id)).then((r) => r[0]);
      const metadata = JSON.parse(row!.metadata!) as { createdByUserId: string };
      expect(metadata.createdByUserId).toBe(session!.user.id);
    });

    it('a rotated successor keeps the same organization and project scope', async () => {
      const a = await createOrgFixture('consistency-rotate');
      const project = await createProject(a.organizationId, a.ownerCookie, 'P');
      const created = (await createKeyHttp(a.organizationId, project.id, a.ownerCookie)).json();

      const rotateRes = await app.inject({ method: 'POST', url: `/v1/organizations/${a.organizationId}/projects/${project.id}/api-keys/${created.id}/rotate`, headers: { cookie: a.ownerCookie, origin: TRUSTED_ORIGIN } });
      const rotated = rotateRes.json();

      const row = await dbClient.db.select().from(apikeyTable).where(eq(apikeyTable.id, rotated.id)).then((r) => r[0]);
      expect(row?.referenceId).toBe(a.organizationId);
      const metadata = JSON.parse(row!.metadata!) as { projectId: string; rotatedFromKeyId: string };
      expect(metadata.projectId).toBe(project.id);
      expect(metadata.rotatedFromKeyId).toBe(created.id);
    });
  });
});
