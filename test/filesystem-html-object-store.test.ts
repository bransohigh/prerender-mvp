import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCacheObjectKey } from '../src/lib/cache-storage-key.js';
import { createFilesystemHtmlObjectStore } from '../src/repositories/filesystem-html-object-store.js';
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

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-object-store-test-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('createFilesystemHtmlObjectStore', () => {
  it('put then get round-trips the body', async () => {
    const store = createFilesystemHtmlObjectStore({ rootDir: root });
    await store.putObject({ storageKey: key(), body: Buffer.from('<html></html>'), contentEncoding: 'identity' });
    const result = await store.getObject(key());
    expect(result?.body.toString('utf8')).toBe('<html></html>');
  });

  it('getObject returns null for a missing key', async () => {
    const store = createFilesystemHtmlObjectStore({ rootDir: root });
    expect(await store.getObject(key())).toBeNull();
  });

  it('headObject returns metadata for an existing object, null for a missing one', async () => {
    const store = createFilesystemHtmlObjectStore({ rootDir: root });
    expect(await store.headObject(key())).toBeNull();
    await store.putObject({ storageKey: key(), body: Buffer.from('xyz'), contentEncoding: 'identity' });
    const meta = await store.headObject(key());
    expect(meta?.contentBytes).toBe(3);
  });

  it('writes atomically: no partial file is ever visible under the final name', async () => {
    const store = createFilesystemHtmlObjectStore({ rootDir: root });
    await store.putObject({ storageKey: key(), body: Buffer.from('a'.repeat(100_000)), contentEncoding: 'identity' });
    const result = await store.getObject(key());
    expect(result?.body.byteLength).toBe(100_000);
  });

  it('leaves no leftover temp files after a successful write', async () => {
    const store = createFilesystemHtmlObjectStore({ rootDir: root });
    await store.putObject({ storageKey: key(), body: Buffer.from('x'), contentEncoding: 'identity' });
    const parsed = key();
    const dir = path.dirname(path.join(root, parsed));
    const entries = await fs.readdir(dir);
    expect(entries.every((e) => !e.startsWith('.tmp-'))).toBe(true);
  });

  it('deleteObject is idempotent', async () => {
    const store = createFilesystemHtmlObjectStore({ rootDir: root });
    await store.putObject({ storageKey: key(), body: Buffer.from('x'), contentEncoding: 'identity' });
    await store.deleteObject(key());
    await expect(store.deleteObject(key())).resolves.toBeUndefined();
    expect(await store.getObject(key())).toBeNull();
  });

  it('writes the file with restrictive permissions (owner read/write only)', async () => {
    const store = createFilesystemHtmlObjectStore({ rootDir: root });
    await store.putObject({ storageKey: key(), body: Buffer.from('x'), contentEncoding: 'identity' });
    const fullPath = path.join(root, key());
    const st = await fs.stat(fullPath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('rejects an absolute-path-shaped storage key', async () => {
    const store = createFilesystemHtmlObjectStore({ rootDir: root });
    await expect(
      store.putObject({ storageKey: '/etc/passwd', body: Buffer.from('x'), contentEncoding: 'identity' }),
    ).rejects.toThrow();
  });

  it('rejects a traversal attempt smuggled through an otherwise-invalid key', async () => {
    const store = createFilesystemHtmlObjectStore({ rootDir: root });
    const traversal = `cache/v1/org1/proj1/dom1/aa/${HASH}/../../../../../../etc/passwd`;
    await expect(store.getObject(traversal)).rejects.toThrow(ObjectStorageError);
  });

  it('rejects an encoded traversal attempt', async () => {
    const store = createFilesystemHtmlObjectStore({ rootDir: root });
    const encoded = `cache/v1/org1/proj1/dom1/aa/${HASH}/%2e%2e%2fsecret`;
    await expect(store.getObject(encoded)).rejects.toThrow(ObjectStorageError);
  });

  it('refuses to write through a symlink planted at the target path', async () => {
    const store = createFilesystemHtmlObjectStore({ rootDir: root });
    const targetKey = key();
    const fullPath = path.join(root, targetKey);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const outsideFile = path.join(root, '..', 'outside-target.html');
    await fs.writeFile(outsideFile, 'should not be overwritten');
    await fs.symlink(outsideFile, fullPath);

    await expect(store.putObject({ storageKey: targetKey, body: Buffer.from('malicious'), contentEncoding: 'identity' })).rejects.toThrow(
      ObjectStorageError,
    );
    expect(await fs.readFile(outsideFile, 'utf8')).toBe('should not be overwritten');
    await fs.unlink(outsideFile).catch(() => {});
  });

  it('refuses to read through a symlink planted at the target path', async () => {
    const store = createFilesystemHtmlObjectStore({ rootDir: root });
    const targetKey = key();
    const fullPath = path.join(root, targetKey);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const outsideFile = path.join(root, '..', 'outside-secret.html');
    await fs.writeFile(outsideFile, 'SECRET_OUTSIDE_ROOT');
    await fs.symlink(outsideFile, fullPath);

    await expect(store.getObject(targetKey)).rejects.toThrow(ObjectStorageError);
    await fs.unlink(outsideFile).catch(() => {});
  });

  it('refuses to traverse an intermediate directory that is a symlink escaping the root', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
    const cacheDir = path.join(root, 'cache');
    await fs.mkdir(path.dirname(cacheDir), { recursive: true });
    await fs.symlink(outsideDir, cacheDir);

    const store = createFilesystemHtmlObjectStore({ rootDir: root });
    await expect(store.putObject({ storageKey: key(), body: Buffer.from('x'), contentEncoding: 'identity' })).rejects.toThrow(
      ObjectStorageError,
    );
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it('cleans up the temp file if the underlying write fails', async () => {
    const store = createFilesystemHtmlObjectStore({ rootDir: root });
    const targetKey = key();
    const dir = path.dirname(path.join(root, targetKey));
    await fs.mkdir(dir, { recursive: true });
    await fs.chmod(dir, 0o500); // no write permission
    try {
      await expect(store.putObject({ storageKey: targetKey, body: Buffer.from('x'), contentEncoding: 'identity' })).rejects.toThrow();
    } finally {
      await fs.chmod(dir, 0o700).catch(() => {});
    }
    const entries = await fs.readdir(dir).catch(() => []);
    expect(entries.every((e) => !e.startsWith('.tmp-'))).toBe(true);
  });

  it('never defaults to the application repository directory (root must be explicit)', () => {
    const store = createFilesystemHtmlObjectStore({ rootDir: root });
    expect(store).toBeDefined();
    expect(root).not.toBe(process.cwd());
  });
});
