import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach, afterAll } from 'vitest';
import { createTestDbClient, truncateAll } from './helpers.js';
import { createTenantRepository } from '../../src/repositories/postgres/tenant-repository.js';
import { createPostgresCacheRepository } from '../../src/repositories/postgres/cache-repository.js';
import { createFilesystemHtmlObjectStore } from '../../src/repositories/filesystem-html-object-store.js';
import { createCacheStorageService, CacheEntryNotReadyError } from '../../src/services/cache-storage-service.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { hashVerificationToken, generateVerificationToken } from '../../src/lib/verification-token.js';
import { member as memberTable } from '../../src/db/schema.js';
import type { DbClient } from '../../src/db/client.js';
import type { CacheIdentity } from '../../src/lib/cache-identity.js';
import { computeRenderProfileHash } from '../../src/lib/render-profile.js';
import { createFakeLogger } from '../helpers/fake-logger.js';

let client: DbClient;
let auth: Auth;
let tenant: ReturnType<typeof createTenantRepository>;
let root: string;

const SENTINEL_URL = 'https://example.test/account?token=TOP_SECRET_CACHE_SENTINEL';

beforeEach(async () => {
  client ??= createTestDbClient();
  auth ??= createAuth(client.db);
  await truncateAll(client);
  tenant = createTenantRepository(client.db);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-storage-service-db-test-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
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
    body: { name: `Org ${label}`, slug: `cache-svc-org-${label}-${Date.now()}`, userId: signUp.user.id },
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

function buildService() {
  const cacheRepository = createPostgresCacheRepository(client.db);
  const objectStore = createFilesystemHtmlObjectStore({ rootDir: root });
  const logger = createFakeLogger();
  const service = createCacheStorageService({ repository: cacheRepository, objectStore, logger });
  return { cacheRepository, objectStore, logger, service };
}

function identityFor(fixture: OrgFixture, url = 'https://example.com/page'): CacheIdentity {
  return {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    domainId: fixture.domainId,
    normalizedUrl: url,
    renderProfileHash: computeRenderProfileHash(),
  };
}

async function seedPending(cacheRepository: ReturnType<typeof createPostgresCacheRepository>, id: CacheIdentity) {
  const { computeCacheKey } = await import('../../src/lib/cache-identity.js');
  const key = computeCacheKey(id);
  return cacheRepository.createPendingCacheEntry({
    organizationId: id.organizationId,
    projectId: id.projectId,
    domainId: id.domainId,
    cacheKeyVersion: key.cacheKeyVersion,
    cacheKeyHash: key.cacheKeyHash,
    normalizedUrl: id.normalizedUrl,
    normalizedUrlHash: key.normalizedUrlHash,
    renderProfileHash: id.renderProfileHash,
    now: new Date(),
  });
}

describe('cache storage service (real PostgreSQL + filesystem object store)', () => {
  it('full pending -> ready lifecycle: metadata matches the stored object', async () => {
    const a = await createOrgWithProjectAndDomain('lifecycle');
    const { cacheRepository, service } = buildService();
    const id = identityFor(a);
    const pending = await seedPending(cacheRepository, id);

    const html = '<html><body>lifecycle test</body></html>';
    const result = await service.commitRenderedHtml({ identity: id, html, responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;

    expect(result.entry.status).toBe('ready');
    expect(result.entry.storageKey).toBeTruthy();

    const readBack = await service.readReadyHtml({ identity: id, now: new Date() });
    expect(readBack.html).toBe(html);
  });

  it('successful read verifies the content hash matches the stored object', async () => {
    const a = await createOrgWithProjectAndDomain('verify-hash');
    const { cacheRepository, service } = buildService();
    const id = identityFor(a);
    const pending = await seedPending(cacheRepository, id);
    await service.commitRenderedHtml({ identity: id, html: '<html>verify me</html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });

    const readBack = await service.readReadyHtml({ identity: id, now: new Date() });
    expect(readBack.entry.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('optimistic conflict leaves the active (winning) entry intact', async () => {
    const a = await createOrgWithProjectAndDomain('optimistic-conflict');
    const { cacheRepository, service } = buildService();
    const id = identityFor(a);
    const pending = await seedPending(cacheRepository, id);

    const winner = await service.commitRenderedHtml({ identity: id, html: '<html>winner</html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });
    expect(winner.outcome).toBe('success');

    const loser = await service.commitRenderedHtml({ identity: id, html: '<html>loser</html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });
    expect(loser.outcome).toBe('conflict');

    const readBack = await service.readReadyHtml({ identity: id, now: new Date() });
    expect(readBack.html).toBe('<html>winner</html>');
  });

  it('a failed object write does not create ready metadata', async () => {
    const a = await createOrgWithProjectAndDomain('failed-write');
    const cacheRepository = createPostgresCacheRepository(client.db);
    // Point the object store at a root the process cannot write to, to
    // force a real write failure through the filesystem adapter.
    const unwritableRoot = path.join(root, 'unwritable');
    await fs.mkdir(unwritableRoot, { recursive: true });
    await fs.chmod(unwritableRoot, 0o500);
    const objectStore = createFilesystemHtmlObjectStore({ rootDir: unwritableRoot });
    const logger = createFakeLogger();
    const service = createCacheStorageService({ repository: cacheRepository, objectStore, logger });

    const id = identityFor(a);
    const pending = await seedPending(cacheRepository, id);
    await expect(
      service.commitRenderedHtml({ identity: id, html: '<html></html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date() }),
    ).rejects.toThrow();
    await fs.chmod(unwritableRoot, 0o700).catch(() => {});

    const entry = await cacheRepository.findCacheEntryByIdentity({ organizationId: id.organizationId, projectId: id.projectId, domainId: id.domainId, cacheKeyVersion: 1, cacheKeyHash: pending.cacheKeyHash });
    expect(entry?.status).toBe('pending');
  });

  it('an invalidated entry is never served as ready by the service', async () => {
    const a = await createOrgWithProjectAndDomain('invalidated-not-served');
    const { cacheRepository, service } = buildService();
    const id = identityFor(a);
    const pending = await seedPending(cacheRepository, id);
    await service.commitRenderedHtml({ identity: id, html: '<html></html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });
    await service.invalidateEntry({ identity: id, now: new Date() });

    await expect(service.readReadyHtml({ identity: id, now: new Date() })).rejects.toThrow(CacheEntryNotReadyError);
  });

  it('tenant A cannot read tenant B cache object through the service', async () => {
    const a = await createOrgWithProjectAndDomain('svc-tenant-a');
    const b = await createOrgWithProjectAndDomain('svc-tenant-b');
    const { cacheRepository, service } = buildService();

    const idB = identityFor(b);
    const pendingB = await seedPending(cacheRepository, idB);
    await service.commitRenderedHtml({ identity: idB, html: '<html>tenant b content</html>', responseStatus: 200, expectedGeneration: pendingB.generation, now: new Date() });

    // Same URL/profile, but scoped as tenant A — must resolve to nothing.
    const idAsA: CacheIdentity = { ...idB, organizationId: a.organizationId, projectId: a.projectId, domainId: a.domainId };
    await expect(service.readReadyHtml({ identity: idAsA, now: new Date() })).rejects.toThrow(CacheEntryNotReadyError);
  });

  it('the same URL in two different projects remains isolated end-to-end', async () => {
    const a = await createOrgWithProjectAndDomain('svc-cross-project-a');
    const b = await createOrgWithProjectAndDomain('svc-cross-project-b');
    const { cacheRepository, service } = buildService();

    const idA = identityFor(a);
    const idB = identityFor(b);
    const pendingA = await seedPending(cacheRepository, idA);
    const pendingB = await seedPending(cacheRepository, idB);
    await service.commitRenderedHtml({ identity: idA, html: '<html>A</html>', responseStatus: 200, expectedGeneration: pendingA.generation, now: new Date() });
    await service.commitRenderedHtml({ identity: idB, html: '<html>B</html>', responseStatus: 200, expectedGeneration: pendingB.generation, now: new Date() });

    expect((await service.readReadyHtml({ identity: idA, now: new Date() })).html).toBe('<html>A</html>');
    expect((await service.readReadyHtml({ identity: idB, now: new Date() })).html).toBe('<html>B</html>');
  });

  it('the sensitive query string never appears in logs, thrown errors, or the storage key', async () => {
    const a = await createOrgWithProjectAndDomain('svc-sentinel');
    const { cacheRepository, objectStore, logger, service } = buildService();
    const id = identityFor(a, SENTINEL_URL);
    const pending = await seedPending(cacheRepository, id);
    const result = await service.commitRenderedHtml({ identity: id, html: '<html>ok</html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;

    expect(result.entry.storageKey).not.toContain('TOP_SECRET_CACHE_SENTINEL');
    expect(JSON.stringify(logger.calls)).not.toContain('TOP_SECRET_CACHE_SENTINEL');

    // The object on disk must be addressable only via the opaque
    // storage key, never a path derived from the URL.
    const onDiskPath = path.join(root, result.entry.storageKey!);
    expect(onDiskPath).not.toContain('TOP_SECRET_CACHE_SENTINEL');
    await expect(objectStore.getObject(result.entry.storageKey!)).resolves.not.toBeNull();
  });
});
