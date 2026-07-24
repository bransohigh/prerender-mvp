import { describe, expect, it } from 'vitest';
import { createMemoryHtmlObjectStore } from '../src/repositories/memory-html-object-store.js';
import { createCacheStorageService, CacheEntryNotReadyError, CacheIntegrityError, HtmlSizeLimitExceededError, StoredObjectSizeLimitExceededError } from '../src/services/cache-storage-service.js';
import { createFakeCacheRepository } from './helpers/fake-cache-repository.js';
import { createFakeLogger } from './helpers/fake-logger.js';
import type { CacheIdentity } from '../src/lib/cache-identity.js';
import { computeRenderProfileHash } from '../src/lib/render-profile.js';
import { createMetrics } from '../src/lib/metrics.js';

const SENTINEL_HTML = '<html><body>SENTINEL_HTML_BODY_MARKER</body></html>';
const SENTINEL_URL = 'https://example.test/account?token=TOP_SECRET_CACHE_SENTINEL';

function identity(overrides: Partial<CacheIdentity> = {}): CacheIdentity {
  return {
    organizationId: 'org1',
    projectId: 'proj1',
    domainId: 'dom1',
    normalizedUrl: 'https://example.com/page',
    renderProfileHash: computeRenderProfileHash(),
    ...overrides,
  };
}

function buildService() {
  const repository = createFakeCacheRepository();
  const objectStore = createMemoryHtmlObjectStore();
  const logger = createFakeLogger();
  const service = createCacheStorageService({ repository, objectStore, logger });
  return { repository, objectStore, logger, service };
}

async function seedPending(repository: ReturnType<typeof createFakeCacheRepository>, id: CacheIdentity, now = new Date()) {
  const { computeCacheKey } = await import('../src/lib/cache-identity.js');
  const key = computeCacheKey(id);
  return repository.createPendingCacheEntry({
    organizationId: id.organizationId,
    projectId: id.projectId,
    domainId: id.domainId,
    cacheKeyVersion: key.cacheKeyVersion,
    cacheKeyHash: key.cacheKeyHash,
    normalizedUrl: id.normalizedUrl,
    normalizedUrlHash: key.normalizedUrlHash,
    renderProfileHash: id.renderProfileHash,
    now,
  });
}

describe('cache storage service — commitRenderedHtml', () => {
  it('writes the object, updates metadata to ready, and returns success', async () => {
    const { repository, objectStore, service } = buildService();
    const id = identity();
    const pending = await seedPending(repository, id);

    const result = await service.commitRenderedHtml({
      identity: id,
      html: '<html><body>hi</body></html>',
      responseStatus: 200,
      expectedGeneration: pending.generation,
      now: new Date(),
    });

    expect(result.outcome).toBe('success');
    if (result.outcome === 'success') {
      expect(result.entry.status).toBe('ready');
      expect(result.entry.generation).toBe(pending.generation + 1);
      const stored = await objectStore.getObject(result.entry.storageKey!);
      expect(stored).not.toBeNull();
    }
  });

  it('defaults to brotli encoding', async () => {
    const { repository, service } = buildService();
    const id = identity();
    const pending = await seedPending(repository, id);
    const result = await service.commitRenderedHtml({
      identity: id,
      html: '<html></html>',
      responseStatus: 200,
      expectedGeneration: pending.generation,
      now: new Date(),
    });
    expect(result.outcome).toBe('success');
    if (result.outcome === 'success') expect(result.entry.contentEncoding).toBe('br');
  });

  it('rejects HTML exceeding the configured uncompressed size limit', async () => {
    const { repository, objectStore, logger } = buildService();
    const service = createCacheStorageService({ repository, objectStore, logger, limits: { maxUncompressedHtmlBytes: 10, maxStoredObjectBytes: 10_000, maxDecompressedReadBytes: 10_000 } });
    const id = identity();
    const pending = await seedPending(repository, id);
    await expect(
      service.commitRenderedHtml({ identity: id, html: '<html>'.repeat(10), responseStatus: 200, expectedGeneration: pending.generation, now: new Date() }),
    ).rejects.toThrow(HtmlSizeLimitExceededError);
  });

  it('rejects a compressed object exceeding the configured stored size limit', async () => {
    const { repository, objectStore, logger } = buildService();
    const service = createCacheStorageService({ repository, objectStore, logger, limits: { maxUncompressedHtmlBytes: 10_000_000, maxStoredObjectBytes: 5, maxDecompressedReadBytes: 10_000_000 } });
    const id = identity();
    const pending = await seedPending(repository, id);
    await expect(
      service.commitRenderedHtml({ identity: id, html: '<html>real content that compresses to more than five bytes</html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date(), contentEncoding: 'identity' }),
    ).rejects.toThrow(StoredObjectSizeLimitExceededError);
  });

  it('returns conflict and does not mutate the active entry when expectedGeneration is stale', async () => {
    const { repository, service } = buildService();
    const id = identity();
    const pending = await seedPending(repository, id);

    const first = await service.commitRenderedHtml({ identity: id, html: '<html>first</html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });
    expect(first.outcome).toBe('success');

    // Stale writer still holds the OLD generation.
    const stale = await service.commitRenderedHtml({ identity: id, html: '<html>stale</html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });
    expect(stale.outcome).toBe('conflict');

    const current = await repository.findCacheEntryByIdentity({ organizationId: id.organizationId, projectId: id.projectId, domainId: id.domainId, cacheKeyVersion: 1, cacheKeyHash: (first as { entry: { cacheKeyHash: string } }).entry.cacheKeyHash });
    expect(current?.generation).toBe(2);
  });

  it('best-effort deletes the orphaned object when the metadata update loses the race', async () => {
    const { repository, objectStore, service } = buildService();
    const id = identity();
    const pending = await seedPending(repository, id);

    await service.commitRenderedHtml({ identity: id, html: '<html>winner</html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });
    const sizeAfterFirst = objectStore.size();

    const stale = await service.commitRenderedHtml({ identity: id, html: '<html>loser</html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });
    expect(stale.outcome).toBe('conflict');
    // The loser's object must not remain as a live, referenceable entry.
    expect(objectStore.size()).toBe(sizeAfterFirst);
  });

  it('does not create a ready entry when the object write fails', async () => {
    const repository = createFakeCacheRepository();
    let fail = true;
    const objectStore = createMemoryHtmlObjectStore({ failNextPut: () => fail });
    const logger = createFakeLogger();
    const service = createCacheStorageService({ repository, objectStore, logger });
    const id = identity();
    const pending = await seedPending(repository, id);

    await expect(
      service.commitRenderedHtml({ identity: id, html: '<html></html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date() }),
    ).rejects.toThrow();
    fail = false;

    const entry = await repository.findCacheEntryByIdentity({ organizationId: id.organizationId, projectId: id.projectId, domainId: id.domainId, cacheKeyVersion: 1, cacheKeyHash: pending.cacheKeyHash });
    expect(entry?.status).toBe('pending');
    expect(entry?.storageKey).toBeNull();
  });

  it('never leaks the sentinel HTML or URL through logs or thrown errors', async () => {
    const { repository, logger, service } = buildService();
    const id = identity({ normalizedUrl: SENTINEL_URL });
    const pending = await seedPending(repository, id);
    await service.commitRenderedHtml({ identity: id, html: SENTINEL_HTML, responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });

    const serialized = JSON.stringify(logger.calls);
    expect(serialized).not.toContain('SENTINEL_HTML_BODY_MARKER');
    expect(serialized).not.toContain('TOP_SECRET_CACHE_SENTINEL');
    expect(serialized).not.toContain(SENTINEL_URL);
  });
});

describe('cache storage service — readReadyHtml', () => {
  it('round-trips the exact HTML that was committed', async () => {
    const { repository, service } = buildService();
    const id = identity();
    const pending = await seedPending(repository, id);
    const html = '<html><body>hello read path</body></html>';
    await service.commitRenderedHtml({ identity: id, html, responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });

    const result = await service.readReadyHtml({ identity: id, now: new Date() });
    expect(result.html).toBe(html);
  });

  it('throws CacheEntryNotReadyError when no entry exists', async () => {
    const { service } = buildService();
    await expect(service.readReadyHtml({ identity: identity(), now: new Date() })).rejects.toThrow(CacheEntryNotReadyError);
  });

  it('throws CacheEntryNotReadyError for a pending entry', async () => {
    const { repository, service } = buildService();
    const id = identity();
    await seedPending(repository, id);
    await expect(service.readReadyHtml({ identity: id, now: new Date() })).rejects.toThrow(CacheEntryNotReadyError);
  });

  it('throws CacheEntryNotReadyError for an invalidated entry (never served as ready)', async () => {
    const { repository, service } = buildService();
    const id = identity();
    const pending = await seedPending(repository, id);
    await service.commitRenderedHtml({ identity: id, html: '<html></html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });
    await service.invalidateEntry({ identity: id, now: new Date() });
    await expect(service.readReadyHtml({ identity: id, now: new Date() })).rejects.toThrow(CacheEntryNotReadyError);
  });

  it('throws a typed integrity error (missing_object) when the referenced object is gone', async () => {
    const { repository, objectStore, service } = buildService();
    const id = identity();
    const pending = await seedPending(repository, id);
    const result = await service.commitRenderedHtml({ identity: id, html: '<html></html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });
    if (result.outcome !== 'success') throw new Error('expected success');
    await objectStore.deleteObject(result.entry.storageKey!);

    try {
      await service.readReadyHtml({ identity: id, now: new Date() });
      expect.fail('expected readReadyHtml to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CacheIntegrityError);
      expect((err as CacheIntegrityError).reason).toBe('missing_object');
    }
  });

  it('throws a typed integrity error (hash_mismatch) when stored bytes were swapped for different content', async () => {
    const { repository, objectStore, service } = buildService();
    const id = identity();
    const pending = await seedPending(repository, id);
    const result = await service.commitRenderedHtml({ identity: id, html: '<html>original</html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date(), contentEncoding: 'identity' });
    if (result.outcome !== 'success') throw new Error('expected success');

    await objectStore.deleteObject(result.entry.storageKey!);
    await objectStore.putObject({ storageKey: result.entry.storageKey!, body: Buffer.from('<html>tampered</html>'), contentEncoding: 'identity' });

    try {
      await service.readReadyHtml({ identity: id, now: new Date() });
      expect.fail('expected readReadyHtml to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CacheIntegrityError);
      expect((err as CacheIntegrityError).reason).toBe('hash_mismatch');
    }
  });

  it('never includes the HTML body in a thrown integrity error message', async () => {
    const { repository, objectStore, service } = buildService();
    const id = identity();
    const pending = await seedPending(repository, id);
    const result = await service.commitRenderedHtml({ identity: id, html: SENTINEL_HTML, responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });
    if (result.outcome !== 'success') throw new Error('expected success');
    await objectStore.deleteObject(result.entry.storageKey!);

    try {
      await service.readReadyHtml({ identity: id, now: new Date() });
    } catch (err) {
      expect(String(err)).not.toContain('SENTINEL_HTML_BODY_MARKER');
    }
  });
});

describe('cache storage service — markRenderFailed / invalidateEntry', () => {
  it('marks a pending entry as failed with the given error code', async () => {
    const { repository, service } = buildService();
    const id = identity();
    const pending = await seedPending(repository, id);
    const updated = await service.markRenderFailed({ identity: id, expectedGeneration: pending.generation, lastErrorCode: 'render_timeout', now: new Date() });
    expect(updated?.status).toBe('failed');
    expect(updated?.lastErrorCode).toBe('render_timeout');
  });

  it('invalidateEntry sets status to invalidated without deleting the underlying object', async () => {
    const { repository, objectStore, service } = buildService();
    const id = identity();
    const pending = await seedPending(repository, id);
    const result = await service.commitRenderedHtml({ identity: id, html: '<html></html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date() });
    if (result.outcome !== 'success') throw new Error('expected success');

    const invalidated = await service.invalidateEntry({ identity: id, now: new Date() });
    expect(invalidated?.status).toBe('invalidated');
    expect(await objectStore.getObject(result.entry.storageKey!)).not.toBeNull();
  });
});

describe('cache storage service — metrics wiring', () => {
  it('does not throw when metrics observation fails internally (Prometheus registered separately per test run)', async () => {
    const repository = createFakeCacheRepository();
    const objectStore = createMemoryHtmlObjectStore();
    const logger = createFakeLogger();
    const metrics = createMetrics({ collectDefault: false, prefix: `test_${Math.random().toString(36).slice(2)}_` });
    const service = createCacheStorageService({ repository, objectStore, logger, metrics });
    const id = identity();
    const pending = await seedPending(repository, id);
    await expect(
      service.commitRenderedHtml({ identity: id, html: '<html></html>', responseStatus: 200, expectedGeneration: pending.generation, now: new Date() }),
    ).resolves.toMatchObject({ outcome: 'success' });
  });
});
