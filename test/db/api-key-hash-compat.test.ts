import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createDbClient, type DbClient } from '../../src/db/client.js';
import { env } from '../../src/config/env.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { truncateAll } from './helpers.js';
import { member as memberTable, apikey as apikeyTable } from '../../src/db/schema.js';
import { hashApiKeySecret } from '../../src/repositories/postgres/api-key-repository.js';

// Compatibility contract between src/repositories/postgres/api-key-repository.ts's
// local hashApiKeySecret() wrapper and Better Auth's own auth.api.verifyApiKey.
// If a future @better-auth/api-key upgrade changes how it hashes/looks up
// keys, this test fails and hashApiKeySecret (the single wrapper around
// the package's defaultKeyHasher export) is the one place to fix.

let dbClient: DbClient;
let auth: Auth;
let app: FastifyInstance;

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

describe('Better Auth key-hashing compatibility (@better-auth/api-key)', () => {
  it('a key hashed by the local wrapper is accepted by auth.api.verifyApiKey', async () => {
    const signUp = await auth.api.signUpEmail({ body: { email: 'compat-owner@example.com', name: 'Owner', password: PASSWORD } });
    const org = await auth.api.createOrganization({ body: { name: 'Compat Org', slug: `compat-org-${Date.now()}`, userId: signUp.user.id } });
    if (!org) throw new Error('org create failed');
    const existing = await dbClient.db.query.member.findFirst({ where: and(eq(memberTable.organizationId, org.id), eq(memberTable.userId, signUp.user.id)) });
    if (!existing) {
      await dbClient.db.insert(memberTable).values({ id: `mem_${signUp.user.id}_${org.id}`, organizationId: org.id, userId: signUp.user.id, role: 'owner', createdAt: new Date() });
    }

    const plaintext = 'pr_live_compat-test-secret-0123456789abcdef';
    const hashed = await hashApiKeySecret(plaintext);
    expect(hashed).not.toBe(plaintext);

    await dbClient.db.insert(apikeyTable).values({
      id: crypto.randomUUID(),
      configId: 'default',
      name: 'Compat Key',
      prefix: 'pr_live_',
      start: plaintext.slice(0, 6),
      key: hashed,
      referenceId: org.id,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: null,
    });

    const result = await auth.api.verifyApiKey({ body: { key: plaintext } });
    expect(result.valid).toBe(true);
  });

  it('an incorrect key is rejected', async () => {
    const signUp = await auth.api.signUpEmail({ body: { email: 'compat-owner2@example.com', name: 'Owner', password: PASSWORD } });
    const org = await auth.api.createOrganization({ body: { name: 'Compat Org 2', slug: `compat-org2-${Date.now()}`, userId: signUp.user.id } });
    if (!org) throw new Error('org create failed');

    const correctPlaintext = 'pr_live_correct-secret-abcdefabcdefabcdef';
    const hashed = await hashApiKeySecret(correctPlaintext);
    await dbClient.db.insert(apikeyTable).values({
      id: crypto.randomUUID(),
      configId: 'default',
      name: 'Compat Key',
      prefix: 'pr_live_',
      start: correctPlaintext.slice(0, 6),
      key: hashed,
      referenceId: org.id,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: null,
    });

    const wrongResult = await auth.api.verifyApiKey({ body: { key: 'pr_live_totally-different-secret-value-xx' } });
    expect(wrongResult.valid).toBe(false);
  });

  it('the plaintext key is never stored in the database', async () => {
    const signUp = await auth.api.signUpEmail({ body: { email: 'compat-owner3@example.com', name: 'Owner', password: PASSWORD } });
    const org = await auth.api.createOrganization({ body: { name: 'Compat Org 3', slug: `compat-org3-${Date.now()}`, userId: signUp.user.id } });
    if (!org) throw new Error('org create failed');

    const plaintext = 'pr_live_never-stored-plaintext-check-value';
    const hashed = await hashApiKeySecret(plaintext);
    const id = crypto.randomUUID();
    await dbClient.db.insert(apikeyTable).values({
      id,
      configId: 'default',
      name: 'Compat Key',
      prefix: 'pr_live_',
      start: plaintext.slice(0, 6),
      key: hashed,
      referenceId: org.id,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: null,
    });

    const row = await dbClient.db.select().from(apikeyTable).where(eq(apikeyTable.id, id)).then((r) => r[0]);
    expect(row?.key).not.toBe(plaintext);
    expect(row?.key).toBe(hashed);
  });
});
