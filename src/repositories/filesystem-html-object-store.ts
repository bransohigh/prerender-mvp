import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { InvalidCacheStorageKeyInputError, parseCacheObjectKey } from '../lib/cache-storage-key.js';
import { ObjectStorageError, type HtmlObjectMetadata, type HtmlObjectStore, type PutHtmlObjectInput, type StoredHtmlObject } from './html-object-store.js';

export interface FilesystemHtmlObjectStoreOptions {
  // Must be an absolute path, configured explicitly — see
  // src/config/env.ts's provider startup validation, which rejects a
  // relative or unsafe root. Never defaults to the application repository
  // directory.
  rootDir: string;
}

// Local-filesystem adapter for development/test environments. Every
// write is: write-to-temp-file-in-the-same-directory, then atomically
// rename into place (fs.rename is atomic within the same filesystem) —
// readers never observe a partially-written object. The resolved final
// path is always re-checked to remain inside the configured root, even
// though storage keys are already validated (defense in depth against a
// future caller bypassing key validation).
export function createFilesystemHtmlObjectStore(options: FilesystemHtmlObjectStoreOptions): HtmlObjectStore {
  const root = path.resolve(options.rootDir);

  function resolveObjectPath(storageKey: string): string {
    // Throws InvalidCacheStorageKeyInputError for anything that isn't the
    // exact expected shape — in particular this already rejects absolute
    // keys, `..` segments, and any character outside the safe-segment
    // charset, since parseCacheObjectKey's regex has no way to match
    // them.
    try {
      parseCacheObjectKey(storageKey);
    } catch (err) {
      if (err instanceof InvalidCacheStorageKeyInputError) {
        throw new ObjectStorageError('invalid_key', 'storage key does not match the expected immutable cache object key format');
      }
      throw err;
    }
    if (path.isAbsolute(storageKey)) {
      throw new ObjectStorageError('invalid_key', 'storage key must not be an absolute path');
    }
    const resolved = path.resolve(root, storageKey);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
      throw new ObjectStorageError('invalid_key', 'storage key resolves outside the configured storage root');
    }
    return resolved;
  }

  async function assertNotSymlink(targetPath: string): Promise<void> {
    try {
      const st = await fs.lstat(targetPath);
      if (st.isSymbolicLink()) {
        throw new ObjectStorageError('invalid_key', 'refusing to write through a symlink');
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  // Every ancestor directory under root must not itself be (or pass
  // through) a symlink — mkdir's `recursive: true` alone does not
  // guarantee that, since an existing intermediate path segment could
  // already be a symlink planted by something else with write access to
  // the root. Walk from root downward and refuse the first symlink found.
  async function assertNoSymlinkAncestors(dirPath: string): Promise<void> {
    const relative = path.relative(root, dirPath);
    if (relative === '' || relative.startsWith('..')) return;
    const segments = relative.split(path.sep).filter(Boolean);
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      await assertNotSymlink(current);
    }
  }

  return {
    async putObject(input: PutHtmlObjectInput): Promise<HtmlObjectMetadata> {
      const finalPath = resolveObjectPath(input.storageKey);
      const dir = path.dirname(finalPath);

      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await assertNoSymlinkAncestors(dir);
      await assertNotSymlink(finalPath);

      if (input.ifNotExists) {
        const existing = await fs.stat(finalPath).catch(() => null);
        if (existing) {
          throw new ObjectStorageError('already_exists', 'object already exists at this key');
        }
      } else {
        // Content-addressed immutable keys: if the object is already
        // there, the bytes are (by construction) identical — treat as a
        // no-op success rather than re-writing.
        const existing = await fs.stat(finalPath).catch(() => null);
        if (existing) {
          return { contentEncoding: parseCacheObjectKey(input.storageKey).contentEncoding, contentBytes: existing.size };
        }
      }

      const tmpPath = path.join(dir, `.tmp-${randomBytes(16).toString('hex')}`);
      let fh: FileHandle | undefined;
      try {
        fh = await fs.open(tmpPath, 'wx', 0o600);
        await fh.writeFile(input.body);
        await fh.sync();
        await fh.close();
        fh = undefined;
        await fs.rename(tmpPath, finalPath);
      } catch (err) {
        await fs.unlink(tmpPath).catch(() => {});
        if (err instanceof ObjectStorageError) throw err;
        throw new ObjectStorageError('provider_error', 'filesystem write failed');
      } finally {
        if (fh) await fh.close().catch(() => {});
      }

      return { contentEncoding: input.contentEncoding, contentBytes: input.body.byteLength };
    },

    async getObject(storageKey: string): Promise<StoredHtmlObject | null> {
      const finalPath = resolveObjectPath(storageKey);
      try {
        await assertNotSymlink(finalPath);
        const body = await fs.readFile(finalPath);
        return { body, metadata: { contentEncoding: parseCacheObjectKey(storageKey).contentEncoding, contentBytes: body.byteLength } };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        if (err instanceof ObjectStorageError) throw err;
        throw new ObjectStorageError('provider_error', 'filesystem read failed');
      }
    },

    async headObject(storageKey: string): Promise<HtmlObjectMetadata | null> {
      const finalPath = resolveObjectPath(storageKey);
      try {
        await assertNotSymlink(finalPath);
        const st = await fs.stat(finalPath);
        return { contentEncoding: parseCacheObjectKey(storageKey).contentEncoding, contentBytes: st.size };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        if (err instanceof ObjectStorageError) throw err;
        throw new ObjectStorageError('provider_error', 'filesystem stat failed');
      }
    },

    async deleteObject(storageKey: string): Promise<void> {
      const finalPath = resolveObjectPath(storageKey);
      try {
        await fs.unlink(finalPath);
      } catch (err) {
        // Idempotent: deleting an already-missing object is not an error.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw new ObjectStorageError('provider_error', 'filesystem delete failed');
      }
    },
  };
}
