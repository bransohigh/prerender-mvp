import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { createTestDbClient, truncateAll, createFixtureOrganization } from './helpers.js';
import { createPostgresProjectRepository } from '../../src/repositories/postgres/postgres-project-repository.js';
import type { DbClient } from '../../src/db/client.js';
import type { CreateProjectInput, ProjectRepository } from '../../src/repositories/types.js';

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

// Thin wrapper so every test call site doesn't need to repeat
// organizationId — the underlying repository still requires it (DB
// NOT NULL), this test file just isn't exercising multi-org behavior.
function repoFor(client: DbClient, organizationId: string): ProjectRepository {
  const real = createPostgresProjectRepository(client.db);
  return {
    ...real,
    create: (input: CreateProjectInput) => real.create({ ...input, organizationId }),
  };
}

describe('PostgresProjectRepository', () => {
  it('creates and reads back a project', async () => {
    const repo = repoFor(client, organizationId);
    const created = await repo.create({ name: 'Example', slug: 'example' });
    expect(created.id).toBeTruthy();

    const found = await repo.findById(created.id);
    expect(found?.slug).toBe('example');
    expect(found?.status).toBe('active');
  });

  it('enforces the unique slug constraint', async () => {
    const repo = repoFor(client, organizationId);
    await repo.create({ name: 'A', slug: 'dup' });
    await expect(repo.create({ name: 'B', slug: 'dup' })).rejects.toMatchObject({
      code: 'PROJECT_SLUG_CONFLICT',
    });
  });

  it('handles concurrent duplicate-slug creates without a race condition', async () => {
    const repo = repoFor(client, organizationId);
    const results = await Promise.allSettled([
      repo.create({ name: 'A', slug: 'concurrent' }),
      repo.create({ name: 'B', slug: 'concurrent' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('soft-deletes: status becomes deleted, row still exists', async () => {
    const repo = repoFor(client, organizationId);
    const created = await repo.create({ name: 'A', slug: 'a' });
    await repo.softDeleteWithCascade(created.id);

    const found = await repo.findById(created.id);
    expect(found?.status).toBe('deleted');
  });

  it('findBySlug excludes deleted projects', async () => {
    const repo = repoFor(client, organizationId);
    const created = await repo.create({ name: 'A', slug: 'a' });
    await repo.softDeleteWithCascade(created.id);

    const found = await repo.findBySlug('a');
    expect(found).toBeNull();
  });

  it('list paginates via cursor', async () => {
    const repo = repoFor(client, organizationId);
    for (let i = 0; i < 5; i++) {
      await repo.create({ name: `P${i}`, slug: `p${i}` });
    }
    const page1 = await repo.list({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await repo.list({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
  });

  it('update rejects a conflicting slug', async () => {
    const repo = repoFor(client, organizationId);
    await repo.create({ name: 'A', slug: 'a' });
    const b = await repo.create({ name: 'B', slug: 'b' });
    await expect(repo.update(b.id, { slug: 'a' })).rejects.toMatchObject({
      code: 'PROJECT_SLUG_CONFLICT',
    });
  });
});
