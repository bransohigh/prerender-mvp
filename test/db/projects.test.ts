import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { createTestDbClient, truncateAll } from './helpers.js';
import { createPostgresProjectRepository } from '../../src/repositories/postgres/postgres-project-repository.js';
import type { DbClient } from '../../src/db/client.js';

let client: DbClient;

beforeEach(async () => {
  client ??= createTestDbClient();
  await truncateAll(client);
});

afterAll(async () => {
  await client?.close();
});

describe('PostgresProjectRepository', () => {
  it('creates and reads back a project', async () => {
    const repo = createPostgresProjectRepository(client.db);
    const created = await repo.create({ name: 'Example', slug: 'example' });
    expect(created.id).toBeTruthy();

    const found = await repo.findById(created.id);
    expect(found?.slug).toBe('example');
    expect(found?.status).toBe('active');
  });

  it('enforces the unique slug constraint', async () => {
    const repo = createPostgresProjectRepository(client.db);
    await repo.create({ name: 'A', slug: 'dup' });
    await expect(repo.create({ name: 'B', slug: 'dup' })).rejects.toMatchObject({
      code: 'PROJECT_SLUG_CONFLICT',
    });
  });

  it('handles concurrent duplicate-slug creates without a race condition', async () => {
    const repo = createPostgresProjectRepository(client.db);
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
    const repo = createPostgresProjectRepository(client.db);
    const created = await repo.create({ name: 'A', slug: 'a' });
    await repo.softDeleteWithCascade(created.id);

    const found = await repo.findById(created.id);
    expect(found?.status).toBe('deleted');
  });

  it('findBySlug excludes deleted projects', async () => {
    const repo = createPostgresProjectRepository(client.db);
    const created = await repo.create({ name: 'A', slug: 'a' });
    await repo.softDeleteWithCascade(created.id);

    const found = await repo.findBySlug('a');
    expect(found).toBeNull();
  });

  it('list paginates via cursor', async () => {
    const repo = createPostgresProjectRepository(client.db);
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
    const repo = createPostgresProjectRepository(client.db);
    await repo.create({ name: 'A', slug: 'a' });
    const b = await repo.create({ name: 'B', slug: 'b' });
    await expect(repo.update(b.id, { slug: 'a' })).rejects.toMatchObject({
      code: 'PROJECT_SLUG_CONFLICT',
    });
  });
});
