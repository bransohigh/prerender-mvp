import { describe, expect, it } from 'vitest';
import { buildCacheObjectKey } from '../src/lib/cache-storage-key.js';
import { createMemoryHtmlObjectStore } from '../src/repositories/memory-html-object-store.js';
import { ObjectStorageError } from '../src/repositories/html-object-store.js';

const HASH = 'a'.repeat(64);
const CONTENT_HASH = 'b'.repeat(64);

function key(generation = 1, contentHash = CONTENT_HASH) {
  return buildCacheObjectKey({
    organizationId: 'org1',
    projectId: 'proj1',
    domainId: 'dom1',
    cacheKeyHash: HASH,
    generation,
    contentHash,
    contentEncoding: 'identity',
  });
}

describe('createMemoryHtmlObjectStore', () => {
  it('put then get round-trips the body and metadata', async () => {
    const store = createMemoryHtmlObjectStore();
    const body = Buffer.from('<html></html>', 'utf8');
    await store.putObject({ storageKey: key(), body, contentEncoding: 'identity' });
    const result = await store.getObject(key());
    expect(result?.body.toString('utf8')).toBe('<html></html>');
    expect(result?.metadata.contentBytes).toBe(body.byteLength);
    expect(result?.metadata.contentEncoding).toBe('identity');
  });

  it('getObject returns null for a missing key', async () => {
    const store = createMemoryHtmlObjectStore();
    expect(await store.getObject(key())).toBeNull();
  });

  it('headObject returns metadata without the body', async () => {
    const store = createMemoryHtmlObjectStore();
    await store.putObject({ storageKey: key(), body: Buffer.from('x'), contentEncoding: 'identity' });
    const meta = await store.headObject(key());
    expect(meta?.contentBytes).toBe(1);
  });

  it('headObject returns null for a missing key', async () => {
    const store = createMemoryHtmlObjectStore();
    expect(await store.headObject(key())).toBeNull();
  });

  it('deleteObject is idempotent', async () => {
    const store = createMemoryHtmlObjectStore();
    await store.putObject({ storageKey: key(), body: Buffer.from('x'), contentEncoding: 'identity' });
    await store.deleteObject(key());
    await expect(store.deleteObject(key())).resolves.toBeUndefined();
    expect(await store.getObject(key())).toBeNull();
  });

  it('writing the same immutable key twice with the same bytes is a no-op success, not a mutation', async () => {
    const store = createMemoryHtmlObjectStore();
    await store.putObject({ storageKey: key(), body: Buffer.from('first'), contentEncoding: 'identity' });
    await store.putObject({ storageKey: key(), body: Buffer.from('first'), contentEncoding: 'identity' });
    expect(store.size()).toBe(1);
  });

  it('ifNotExists rejects a write to an already-occupied key', async () => {
    const store = createMemoryHtmlObjectStore();
    await store.putObject({ storageKey: key(), body: Buffer.from('x'), contentEncoding: 'identity' });
    await expect(store.putObject({ storageKey: key(), body: Buffer.from('y'), contentEncoding: 'identity', ifNotExists: true })).rejects.toThrow(
      ObjectStorageError,
    );
  });

  it('rejects a put with an invalid (non-key-shaped) storage key', async () => {
    const store = createMemoryHtmlObjectStore();
    await expect(store.putObject({ storageKey: '../../etc/passwd', body: Buffer.from('x'), contentEncoding: 'identity' })).rejects.toThrow();
  });

  it('different generations of the same identity occupy different keys', async () => {
    const store = createMemoryHtmlObjectStore();
    await store.putObject({ storageKey: key(1), body: Buffer.from('gen1'), contentEncoding: 'identity' });
    await store.putObject({ storageKey: key(2), body: Buffer.from('gen2'), contentEncoding: 'identity' });
    expect((await store.getObject(key(1)))?.body.toString()).toBe('gen1');
    expect((await store.getObject(key(2)))?.body.toString()).toBe('gen2');
  });

  it('supports injected put/delete failures for rollback/cleanup tests', async () => {
    let shouldFail = true;
    const store = createMemoryHtmlObjectStore({ failNextPut: () => shouldFail });
    await expect(store.putObject({ storageKey: key(), body: Buffer.from('x'), contentEncoding: 'identity' })).rejects.toThrow(
      ObjectStorageError,
    );
    shouldFail = false;
    await expect(store.putObject({ storageKey: key(), body: Buffer.from('x'), contentEncoding: 'identity' })).resolves.toBeDefined();
  });
});
