import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { createTestDbClient, truncateAll } from './helpers.js';
import { createPostgresProjectRepository } from '../../src/repositories/postgres/postgres-project-repository.js';
import { createPostgresDomainRepository } from '../../src/repositories/postgres/postgres-domain-repository.js';
import { createPostgresSitemapRepository } from '../../src/repositories/postgres/postgres-sitemap-repository.js';
import { createPostgresDiscoveredUrlRepository } from '../../src/repositories/postgres/postgres-discovered-url-repository.js';
import { hashVerificationToken, generateVerificationToken } from '../../src/lib/verification-token.js';
import type { DbClient } from '../../src/db/client.js';

let client: DbClient;

beforeEach(async () => {
  client ??= createTestDbClient();
  await truncateAll(client);
});

afterAll(async () => {
  await client?.close();
});

async function makeDomainId(): Promise<string> {
  const projectRepo = createPostgresProjectRepository(client.db);
  const project = await projectRepo.create({ name: 'P', slug: `p-${Date.now()}-${Math.random()}` });
  const domainRepo = createPostgresDomainRepository(client.db);
  const domain = await domainRepo.create({
    projectId: project.id,
    hostname: `d${Date.now()}${Math.random()}.example.com`,
    normalizedHostname: `d${Date.now()}${Math.random()}.example.com`,
    verificationMethod: 'dns_txt',
    verificationTokenHash: hashVerificationToken(generateVerificationToken()),
  });
  return domain.id;
}

describe('PostgresSitemapRepository', () => {
  it('upsert is idempotent for the same domain+url', async () => {
    const domainId = await makeDomainId();
    const repo = createPostgresSitemapRepository(client.db);
    const first = await repo.upsert({
      domainId,
      url: 'https://example.com/sitemap.xml',
      normalizedUrl: 'https://example.com/sitemap.xml',
      type: 'sitemap',
    });
    const second = await repo.upsert({
      domainId,
      url: 'https://example.com/sitemap.xml',
      normalizedUrl: 'https://example.com/sitemap.xml',
      type: 'sitemap',
    });
    expect(second.id).toBe(first.id);

    const all = await repo.listByDomain(domainId);
    expect(all).toHaveLength(1);
  });

  it('recordFetchResult updates status and counters', async () => {
    const domainId = await makeDomainId();
    const repo = createPostgresSitemapRepository(client.db);
    const source = await repo.upsert({
      domainId,
      url: 'https://example.com/sitemap.xml',
      normalizedUrl: 'https://example.com/sitemap.xml',
      type: 'sitemap',
    });

    const updated = await repo.recordFetchResult(source.id, {
      status: 'success',
      lastHttpStatus: 200,
      discoveredUrlCount: 42,
    });
    expect(updated?.status).toBe('success');
    expect(updated?.discoveredUrlCount).toBe(42);
    expect(updated?.lastFetchedAt).not.toBeNull();
  });
});

describe('PostgresDiscoveredUrlRepository', () => {
  it('upsertMany inserts new URLs and is idempotent on domain+normalizedUrl', async () => {
    const domainId = await makeDomainId();
    const repo = createPostgresDiscoveredUrlRepository(client.db);

    const count1 = await repo.upsertMany([
      { domainId, sitemapSourceId: null, url: 'https://example.com/a', normalizedUrl: 'https://example.com/a', path: '/a' },
      { domainId, sitemapSourceId: null, url: 'https://example.com/b', normalizedUrl: 'https://example.com/b', path: '/b' },
    ]);
    expect(count1).toBe(2);
    expect(await repo.countByDomain(domainId)).toBe(2);

    // Re-upsert the same URL — should update, not duplicate.
    const count2 = await repo.upsertMany([
      { domainId, sitemapSourceId: null, url: 'https://example.com/a', normalizedUrl: 'https://example.com/a', path: '/a', lastmod: '2024-01-01' },
    ]);
    expect(count2).toBe(1);
    expect(await repo.countByDomain(domainId)).toBe(2);
  });

  it('paginates listByDomain via cursor', async () => {
    const domainId = await makeDomainId();
    const repo = createPostgresDiscoveredUrlRepository(client.db);
    const inputs = Array.from({ length: 5 }, (_, i) => ({
      domainId,
      sitemapSourceId: null,
      url: `https://example.com/${i}`,
      normalizedUrl: `https://example.com/${i}`,
      path: `/${i}`,
    }));
    await repo.upsertMany(inputs);

    const page1 = await repo.listByDomain(domainId, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await repo.listByDomain(domainId, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(2);
  });

  it('batch upsert commits atomically (count matches input, no partial rows)', async () => {
    const domainId = await makeDomainId();
    const repo = createPostgresDiscoveredUrlRepository(client.db);
    const inputs = Array.from({ length: 10 }, (_, i) => ({
      domainId,
      sitemapSourceId: null,
      url: `https://example.com/batch/${i}`,
      normalizedUrl: `https://example.com/batch/${i}`,
      path: `/batch/${i}`,
    }));
    const count = await repo.upsertMany(inputs);
    expect(count).toBe(10);
    expect(await repo.countByDomain(domainId)).toBe(10);
  });

  it('rolls back the whole batch when one entry violates the domain FK', async () => {
    const domainId = await makeDomainId();
    const repo = createPostgresDiscoveredUrlRepository(client.db);
    const inputs = [
      { domainId, sitemapSourceId: null, url: 'https://example.com/ok', normalizedUrl: 'https://example.com/ok', path: '/ok' },
      {
        domainId: '00000000-0000-0000-0000-000000000000', // violates FK -> whole transaction rolls back
        sitemapSourceId: null,
        url: 'https://example.com/bad',
        normalizedUrl: 'https://example.com/bad',
        path: '/bad',
      },
    ];
    await expect(repo.upsertMany(inputs)).rejects.toThrow();
    expect(await repo.countByDomain(domainId)).toBe(0);
  });
});
