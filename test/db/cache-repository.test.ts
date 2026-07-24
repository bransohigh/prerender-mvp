import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDbClient, truncateAll } from './helpers.js';
import { createTenantRepository } from '../../src/repositories/postgres/tenant-repository.js';
import { createPostgresCacheRepository } from '../../src/repositories/postgres/cache-repository.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { hashVerificationToken, generateVerificationToken } from '../../src/lib/verification-token.js';
import { member as memberTable, cacheEntries } from '../../src/db/schema.js';
import type { DbClient } from '../../src/db/client.js';
import { computeCacheKey } from '../../src/lib/cache-identity.js';
import { computeRenderProfileHash } from '../../src/lib/render-profile.js';

let client: DbClient;
let auth: Auth;
let tenant: ReturnType<typeof createTenantRepository>;
let cacheRepo: ReturnType<typeof createPostgresCacheRepository>;

const SENTINEL_URL = 'https://example.test/account?token=TOP_SECRET_CACHE_SENTINEL';

beforeEach(async () => {
  client ??= createTestDbClient();
  auth ??= createAuth(client.db);
  await truncateAll(client);
  tenant = createTenantRepository(client.db);
  cacheRepo = createPostgresCacheRepository(client.db);
});

afterAll(async () => {
  await client?.close();
});

interface OrgFixture {
  organizationId: string;
  projectId: string;
  domainId: string;
}

async function createOrgWithProjectAndDomain(label: string): Promise<OrgFixture> {
  const signUp = await auth.api.signUpEmail({
    body: { email: `owner-${label}@example.com`, name: `Owner ${label}`, password: 'correct-horse-battery-staple' },
  });
  const org = await auth.api.createOrganization({
    body: { name: `Org ${label}`, slug: `cache-org-${label}-${Date.now()}`, userId: signUp.user.id },
  });
  if (!org) throw new Error('org create failed');

  await client.db.insert(memberTable).values({
    id: `mem_${signUp.user.id}_${org.id}`,
    organizationId: org.id,
    userId: signUp.user.id,
    role: 'owner',
    createdAt: new Date(),
  });

  const project = await tenant.createProjectForOrganization(org.id, { name: `Project ${label}`, slug: `project-${label}-${Date.now()}` }, signUp.user.id, null);
  const domain = await tenant.createDomainForOrganization(org.id, project.id, {
    hostname: `${label}.example.com`,
    normalizedHostname: `${label}.example.com`,
    verificationMethod: 'dns_txt',
    verificationTokenHash: hashVerificationToken(generateVerificationToken()),
  }, signUp.user.id, null);

  return { organizationId: org.id, projectId: project.id, domainId: domain.id };
}

function identityFor(fixture: OrgFixture, url = 'https://example.com/page', profileHash = computeRenderProfileHash()) {
  return computeCacheKey({
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    domainId: fixture.domainId,
    normalizedUrl: url,
    renderProfileHash: profileHash,
  });
}

function scopeFor(fixture: OrgFixture, url = 'https://example.com/page', profileHash = computeRenderProfileHash()) {
  const key = identityFor(fixture, url, profileHash);
  return {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    domainId: fixture.domainId,
    cacheKeyVersion: key.cacheKeyVersion,
    cacheKeyHash: key.cacheKeyHash,
  };
}

async function createPending(fixture: OrgFixture, url = 'https://example.com/page', profileHash = computeRenderProfileHash()) {
  const key = identityFor(fixture, url, profileHash);
  return cacheRepo.createPendingCacheEntry({
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    domainId: fixture.domainId,
    cacheKeyVersion: key.cacheKeyVersion,
    cacheKeyHash: key.cacheKeyHash,
    normalizedUrl: url,
    normalizedUrlHash: key.normalizedUrlHash,
    renderProfileHash: profileHash,
    now: new Date(),
  });
}

describe('cache repository (postgres)', () => {
  it('migration applied: cache_entries table exists with expected columns', async () => {
    const result = await client.db.execute(
      sql`select column_name from information_schema.columns where table_name = 'cache_entries' order by column_name`,
    );
    const rows = (result as unknown as { rows?: Array<{ column_name: string }> }).rows ?? (result as unknown as Array<{ column_name: string }>);
    const columns = rows.map((r) => r.column_name);
    expect(columns).toEqual(
      expect.arrayContaining(['id', 'organization_id', 'project_id', 'domain_id', 'cache_key_hash', 'status', 'generation']),
    );
  });

  it('creates a pending entry and finds it by exact identity', async () => {
    const a = await createOrgWithProjectAndDomain('find-a');
    const created = await createPending(a);
    expect(created.status).toBe('pending');
    expect(created.generation).toBe(1);

    const found = await cacheRepo.findCacheEntryByIdentity(scopeFor(a));
    expect(found?.id).toBe(created.id);
  });

  it('returns null from findCacheEntryByIdentity for a non-existent identity', async () => {
    const a = await createOrgWithProjectAndDomain('find-miss');
    expect(await cacheRepo.findCacheEntryByIdentity(scopeFor(a))).toBeNull();
  });

  it('isolates entries across projects: same URL under two different projects produces distinct rows', async () => {
    const a = await createOrgWithProjectAndDomain('cross-project-a');
    const b = await createOrgWithProjectAndDomain('cross-project-b');
    const entryA = await createPending(a);
    const entryB = await createPending(b);
    expect(entryA.id).not.toBe(entryB.id);
    expect(await cacheRepo.findCacheEntryByIdentity(scopeFor(a))).not.toBeNull();
    expect(await cacheRepo.findCacheEntryByIdentity(scopeFor(b))).not.toBeNull();
  });

  it('isolates entries across domains within the same org/project-shape (different fixtures = different domains too)', async () => {
    const a = await createOrgWithProjectAndDomain('cross-domain-a');
    const b = await createOrgWithProjectAndDomain('cross-domain-b');
    await createPending(a);
    const scopedAsB = { ...scopeFor(a), domainId: b.domainId };
    expect(await cacheRepo.findCacheEntryByIdentity(scopedAsB)).toBeNull();
  });

  it('isolates entries across render profiles for the same URL', async () => {
    const a = await createOrgWithProjectAndDomain('cross-profile');
    const profileA = computeRenderProfileHash({ waitStrategy: 'load' });
    const profileB = computeRenderProfileHash({ waitStrategy: 'networkidle' });
    const entryA = await createPending(a, 'https://example.com/page', profileA);
    const entryB = await createPending(a, 'https://example.com/page', profileB);
    expect(entryA.id).not.toBe(entryB.id);
  });

  it('handles duplicate identity creation atomically: second createPendingCacheEntry returns the existing row, not a new one', async () => {
    const a = await createOrgWithProjectAndDomain('dup-identity');
    const first = await createPending(a);
    const second = await createPending(a);
    expect(second.id).toBe(first.id);

    const allRows = await client.db.select().from(cacheEntries).where(eq(cacheEntries.organizationId, a.organizationId));
    expect(allRows).toHaveLength(1);
  });

  it('rejects a cross-tenant insert (project from org A combined with domain from org B) via the composite foreign keys', async () => {
    const a = await createOrgWithProjectAndDomain('xt-a');
    const b = await createOrgWithProjectAndDomain('xt-b');
    const key = identityFor(a);

    await expect(
      cacheRepo.createPendingCacheEntry({
        organizationId: a.organizationId,
        projectId: a.projectId,
        domainId: b.domainId, // domain belongs to org B's project, not a.projectId
        cacheKeyVersion: key.cacheKeyVersion,
        cacheKeyHash: key.cacheKeyHash,
        normalizedUrl: 'https://example.com/page',
        normalizedUrlHash: key.normalizedUrlHash,
        renderProfileHash: computeRenderProfileHash(),
        now: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('updateReadyCacheEntry transitions pending -> ready and requires content fields (ready-state constraint)', async () => {
    const a = await createOrgWithProjectAndDomain('ready-transition');
    const pending = await createPending(a);
    const now = new Date();
    const ready = await cacheRepo.updateReadyCacheEntry({
      ...scopeFor(a),
      storageKey: 'cache/v1/x/y/z/aa/' + 'a'.repeat(64) + '.html',
      contentHash: 'b'.repeat(64),
      contentEncoding: 'identity',
      contentBytes: 1234,
      responseStatus: 200,
      renderedAt: now,
      freshUntil: new Date(now.getTime() + 300_000),
      staleUntil: new Date(now.getTime() + 3_600_000),
      expectedGeneration: pending.generation,
      now,
    });
    expect(ready?.status).toBe('ready');
    expect(ready?.generation).toBe(pending.generation + 1);
  });

  it('database rejects a ready row missing required content fields directly (defense in depth)', async () => {
    const a = await createOrgWithProjectAndDomain('ready-constraint');
    const key = identityFor(a);
    await expect(
      client.db.insert(cacheEntries).values({
        organizationId: a.organizationId,
        projectId: a.projectId,
        domainId: a.domainId,
        cacheKeyVersion: key.cacheKeyVersion,
        cacheKeyHash: key.cacheKeyHash,
        normalizedUrl: 'https://example.com/page',
        normalizedUrlHash: key.normalizedUrlHash,
        renderProfileHash: computeRenderProfileHash(),
        status: 'ready', // no storageKey/contentHash/renderedAt/freshUntil/staleUntil
      }),
    ).rejects.toThrow();
  });

  it('database rejects staleUntil before freshUntil directly', async () => {
    const a = await createOrgWithProjectAndDomain('stale-before-fresh');
    const key = identityFor(a);
    const now = new Date();
    await expect(
      client.db.insert(cacheEntries).values({
        organizationId: a.organizationId,
        projectId: a.projectId,
        domainId: a.domainId,
        cacheKeyVersion: key.cacheKeyVersion,
        cacheKeyHash: key.cacheKeyHash,
        normalizedUrl: 'https://example.com/page',
        normalizedUrlHash: key.normalizedUrlHash,
        renderProfileHash: computeRenderProfileHash(),
        status: 'ready',
        storageKey: 'cache/v1/x/y/z/aa/' + 'a'.repeat(64) + '.html',
        contentHash: 'b'.repeat(64),
        contentBytes: 10,
        responseStatus: 200,
        renderedAt: now,
        freshUntil: now,
        staleUntil: new Date(now.getTime() - 1000), // before freshUntil
      }),
    ).rejects.toThrow();
  });

  it('database rejects an invalidated row missing invalidatedAt directly', async () => {
    const a = await createOrgWithProjectAndDomain('invalidated-constraint');
    const key = identityFor(a);
    await expect(
      client.db.insert(cacheEntries).values({
        organizationId: a.organizationId,
        projectId: a.projectId,
        domainId: a.domainId,
        cacheKeyVersion: key.cacheKeyVersion,
        cacheKeyHash: key.cacheKeyHash,
        normalizedUrl: 'https://example.com/page',
        normalizedUrlHash: key.normalizedUrlHash,
        renderProfileHash: computeRenderProfileHash(),
        status: 'invalidated', // no invalidatedAt
      }),
    ).rejects.toThrow();
  });

  it('optimistic generation update: updateReadyCacheEntry with a stale expectedGeneration returns null and does not overwrite', async () => {
    const a = await createOrgWithProjectAndDomain('optimistic-stale');
    const pending = await createPending(a);
    const now = new Date();
    const readyInput = {
      ...scopeFor(a),
      storageKey: 'cache/v1/x/y/z/aa/' + 'a'.repeat(64) + '.html',
      contentHash: 'b'.repeat(64),
      contentEncoding: 'identity',
      contentBytes: 10,
      responseStatus: 200,
      renderedAt: now,
      freshUntil: new Date(now.getTime() + 300_000),
      staleUntil: new Date(now.getTime() + 3_600_000),
      now,
    };
    const firstWrite = await cacheRepo.updateReadyCacheEntry({ ...readyInput, expectedGeneration: pending.generation });
    expect(firstWrite?.generation).toBe(2);

    // Second writer still thinks generation is 1 (stale read) — must not overwrite.
    const staleWrite = await cacheRepo.updateReadyCacheEntry({ ...readyInput, expectedGeneration: pending.generation });
    expect(staleWrite).toBeNull();

    const current = await cacheRepo.findCacheEntryByIdentity(scopeFor(a));
    expect(current?.generation).toBe(2);
    expect(current?.contentHash).toBe('b'.repeat(64));
  });

  it('generation never moves backwards across repeated successful writes', async () => {
    const a = await createOrgWithProjectAndDomain('generation-monotonic');
    const pending = await createPending(a);
    const now = new Date();
    const firstReady = await cacheRepo.updateReadyCacheEntry({
      ...scopeFor(a),
      storageKey: 'cache/v1/x/y/z/aa/' + 'a'.repeat(64) + '.html',
      contentHash: 'b'.repeat(64),
      contentEncoding: 'identity',
      contentBytes: 10,
      responseStatus: 200,
      renderedAt: now,
      freshUntil: new Date(now.getTime() + 300_000),
      staleUntil: new Date(now.getTime() + 3_600_000),
      expectedGeneration: pending.generation,
      now,
    });
    expect(firstReady?.generation).toBe(2);

    const failed = await cacheRepo.updateFailedCacheEntry({
      ...scopeFor(a),
      lastErrorCode: 'render_timeout',
      expectedGeneration: firstReady!.generation,
      now: new Date(),
    });
    expect(failed?.generation).toBe(3);
    expect(failed?.status).toBe('failed');
  });

  it('invalidateCacheEntry sets status=invalidated and invalidatedAt, and bumps generation', async () => {
    const a = await createOrgWithProjectAndDomain('invalidate');
    const pending = await createPending(a);
    const invalidated = await cacheRepo.invalidateCacheEntry({ ...scopeFor(a), now: new Date() });
    expect(invalidated?.status).toBe('invalidated');
    expect(invalidated?.invalidatedAt).not.toBeNull();
    expect(invalidated?.generation).toBe(pending.generation + 1);
  });

  it('tenant A cannot read, update, or invalidate tenant B cache entries', async () => {
    const a = await createOrgWithProjectAndDomain('tenant-a');
    const b = await createOrgWithProjectAndDomain('tenant-b');
    const entryB = await createPending(b);

    const scopedAsA = { ...scopeFor(b), organizationId: a.organizationId };
    expect(await cacheRepo.findCacheEntryByIdentity(scopedAsA)).toBeNull();

    const now = new Date();
    const updateResult = await cacheRepo.updateReadyCacheEntry({
      ...scopedAsA,
      storageKey: 'cache/v1/x/y/z/aa/' + 'a'.repeat(64) + '.html',
      contentHash: 'c'.repeat(64),
      contentEncoding: 'identity',
      contentBytes: 1,
      responseStatus: 200,
      renderedAt: now,
      freshUntil: new Date(now.getTime() + 1000),
      staleUntil: new Date(now.getTime() + 2000),
      expectedGeneration: entryB.generation,
      now,
    });
    expect(updateResult).toBeNull();

    const invalidateResult = await cacheRepo.invalidateCacheEntry({ ...scopedAsA, now: new Date() });
    expect(invalidateResult).toBeNull();

    const untouched = await cacheRepo.findCacheEntryByIdentity(scopeFor(b));
    expect(untouched?.status).toBe('pending');
  });

  it('never leaks the sentinel normalized URL through a thrown repository error message', async () => {
    const a = await createOrgWithProjectAndDomain('sentinel-a');
    const b = await createOrgWithProjectAndDomain('sentinel-b');
    const key = identityFor(a, SENTINEL_URL);

    let caught: unknown;
    try {
      await cacheRepo.createPendingCacheEntry({
        organizationId: a.organizationId,
        projectId: a.projectId,
        domainId: b.domainId,
        cacheKeyVersion: key.cacheKeyVersion,
        cacheKeyHash: key.cacheKeyHash,
        normalizedUrl: SENTINEL_URL,
        normalizedUrlHash: key.normalizedUrlHash,
        renderProfileHash: computeRenderProfileHash(),
        now: new Date(),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(String(caught)).not.toContain('TOP_SECRET_CACHE_SENTINEL');
    expect((caught as Error).stack ?? '').not.toContain('TOP_SECRET_CACHE_SENTINEL');
  });

  it('the sentinel URL is stored in the DB row by design but is not present in any metric/log-facing repository output field name', async () => {
    const a = await createOrgWithProjectAndDomain('sentinel-storage');
    const created = await createPending(a, SENTINEL_URL);
    expect(created.normalizedUrl).toBe(SENTINEL_URL); // documented: DB row may contain it
    expect(created.storageKey).toBeNull(); // never derived from the raw URL
  });
});
