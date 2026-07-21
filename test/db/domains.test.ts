import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDbClient, truncateAll, createFixtureOrganization } from './helpers.js';
import { createPostgresProjectRepository } from '../../src/repositories/postgres/postgres-project-repository.js';
import { createPostgresDomainRepository } from '../../src/repositories/postgres/postgres-domain-repository.js';
import { hashVerificationToken, generateVerificationToken } from '../../src/lib/verification-token.js';
import type { DbClient } from '../../src/db/client.js';

let client: DbClient;
let organizationId: string;

beforeEach(async () => {
  client ??= createTestDbClient();
  await truncateAll(client);
  organizationId = await createFixtureOrganization(client);
});

afterAll(async () => {
  await client?.close();
});

async function makeProjectId(): Promise<string> {
  const repo = createPostgresProjectRepository(client.db);
  const project = await repo.create({ name: 'P', slug: `p-${Date.now()}-${Math.random()}`, organizationId });
  return project.id;
}

describe('PostgresDomainRepository', () => {
  it('creates a domain scoped to a project (foreign key)', async () => {
    const projectId = await makeProjectId();
    const repo = createPostgresDomainRepository(client.db);
    const domain = await repo.create({
      projectId,
      hostname: 'example.com',
      normalizedHostname: 'example.com',
      verificationMethod: 'dns_txt',
      verificationTokenHash: hashVerificationToken(generateVerificationToken()),
    });
    expect(domain.projectId).toBe(projectId);
    expect(domain.status).toBe('pending');
  });

  it('rejects a domain with a non-existent project (foreign key violation)', async () => {
    const repo = createPostgresDomainRepository(client.db);
    await expect(
      repo.create({
        projectId: '00000000-0000-0000-0000-000000000000',
        hostname: 'example.com',
        normalizedHostname: 'example.com',
        verificationMethod: 'dns_txt',
        verificationTokenHash: hashVerificationToken(generateVerificationToken()),
      }),
    ).rejects.toThrow();
  });

  it('enforces the unique normalized hostname constraint', async () => {
    const projectId = await makeProjectId();
    const repo = createPostgresDomainRepository(client.db);
    await repo.create({
      projectId,
      hostname: 'dup.example.com',
      normalizedHostname: 'dup.example.com',
      verificationMethod: 'dns_txt',
      verificationTokenHash: hashVerificationToken(generateVerificationToken()),
    });
    await expect(
      repo.create({
        projectId,
        hostname: 'dup.example.com',
        normalizedHostname: 'dup.example.com',
        verificationMethod: 'dns_txt',
        verificationTokenHash: hashVerificationToken(generateVerificationToken()),
      }),
    ).rejects.toMatchObject({ code: 'DOMAIN_ALREADY_EXISTS' });
  });

  it('handles concurrent duplicate-domain creates without both succeeding', async () => {
    const projectId = await makeProjectId();
    const repo = createPostgresDomainRepository(client.db);
    const results = await Promise.allSettled([
      repo.create({
        projectId,
        hostname: 'race.example.com',
        normalizedHostname: 'race.example.com',
        verificationMethod: 'dns_txt',
        verificationTokenHash: hashVerificationToken(generateVerificationToken()),
      }),
      repo.create({
        projectId,
        hostname: 'race.example.com',
        normalizedHostname: 'race.example.com',
        verificationMethod: 'dns_txt',
        verificationTokenHash: hashVerificationToken(generateVerificationToken()),
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('cascades delete when the parent project is hard-deleted (FK ON DELETE CASCADE)', async () => {
    const projectId = await makeProjectId();
    const domainRepo = createPostgresDomainRepository(client.db);
    const domain = await domainRepo.create({
      projectId,
      hostname: 'cascade.example.com',
      normalizedHostname: 'cascade.example.com',
      verificationMethod: 'dns_txt',
      verificationTokenHash: hashVerificationToken(generateVerificationToken()),
    });

    // Hard delete directly at the SQL layer to exercise the FK cascade —
    // the repository API only ever soft-deletes projects (by design).
    await client.db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);

    const stillThere = await domainRepo.findById(domain.id);
    expect(stillThere).toBeNull();
  });

  it('markVerificationAttempt(success) sets verified status and resets failure count', async () => {
    const projectId = await makeProjectId();
    const repo = createPostgresDomainRepository(client.db);
    const domain = await repo.create({
      projectId,
      hostname: 'verify.example.com',
      normalizedHostname: 'verify.example.com',
      verificationMethod: 'dns_txt',
      verificationTokenHash: hashVerificationToken(generateVerificationToken()),
    });

    await repo.markVerificationAttempt(domain.id, { success: false, failureCode: 'dns_nxdomain' });
    const afterFail = await repo.findById(domain.id);
    expect(afterFail?.verificationFailureCount).toBe(1);
    expect(afterFail?.status).toBe('failed');

    const verified = await repo.markVerificationAttempt(domain.id, { success: true });
    expect(verified?.status).toBe('verified');
    expect(verified?.verificationFailureCount).toBe(0);
    expect(verified?.verifiedAt).not.toBeNull();
  });

  it('rotateVerificationToken resets a verified domain to pending', async () => {
    const projectId = await makeProjectId();
    const repo = createPostgresDomainRepository(client.db);
    const domain = await repo.create({
      projectId,
      hostname: 'rotate.example.com',
      normalizedHostname: 'rotate.example.com',
      verificationMethod: 'dns_txt',
      verificationTokenHash: hashVerificationToken(generateVerificationToken()),
    });
    await repo.markVerificationAttempt(domain.id, { success: true });

    const rotated = await repo.rotateVerificationToken(domain.id, hashVerificationToken(generateVerificationToken()));
    expect(rotated?.status).toBe('pending');
    expect(rotated?.verifiedAt).toBeNull();
  });
});
