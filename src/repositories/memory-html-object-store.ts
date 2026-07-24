import { parseCacheObjectKey } from '../lib/cache-storage-key.js';
import { ObjectStorageError, type HtmlObjectMetadata, type HtmlObjectStore, type PutHtmlObjectInput, type StoredHtmlObject } from './html-object-store.js';

export interface MemoryHtmlObjectStoreOptions {
  // Injected failure hooks for rollback/cleanup tests — never used in
  // production wiring (see src/config/env.ts's provider validation,
  // which forbids the memory provider outright in production).
  failNextPut?: () => boolean;
  failNextDelete?: () => boolean;
}

interface StoredEntry {
  body: Buffer;
  metadata: HtmlObjectMetadata;
}

// Fast in-process adapter for unit/service tests — models the same
// immutable-key, not-found, and duplicate-key semantics as the real
// adapters so tests written against this one generalize.
export function createMemoryHtmlObjectStore(options: MemoryHtmlObjectStoreOptions = {}): HtmlObjectStore & {
  size(): number;
  clear(): void;
} {
  const store = new Map<string, StoredEntry>();

  return {
    async putObject(input: PutHtmlObjectInput): Promise<HtmlObjectMetadata> {
      parseCacheObjectKey(input.storageKey);
      if (options.failNextPut?.()) {
        throw new ObjectStorageError('provider_error', 'simulated put failure');
      }
      const existing = store.get(input.storageKey);
      if (existing) {
        if (input.ifNotExists) {
          throw new ObjectStorageError('already_exists', 'object already exists at this key');
        }
        // Keys are content-addressed and immutable — writing the same
        // key again is only ever the same bytes; treat as a no-op
        // success rather than mutating stored bytes in place.
        return existing.metadata;
      }
      const metadata: HtmlObjectMetadata = {
        contentEncoding: input.contentEncoding,
        contentBytes: input.body.byteLength,
        createdAt: new Date(),
      };
      store.set(input.storageKey, { body: Buffer.from(input.body), metadata });
      return metadata;
    },

    async getObject(storageKey: string): Promise<StoredHtmlObject | null> {
      const entry = store.get(storageKey);
      if (!entry) return null;
      return { body: Buffer.from(entry.body), metadata: entry.metadata };
    },

    async headObject(storageKey: string): Promise<HtmlObjectMetadata | null> {
      const entry = store.get(storageKey);
      return entry ? entry.metadata : null;
    },

    async deleteObject(storageKey: string): Promise<void> {
      if (options.failNextDelete?.()) {
        throw new ObjectStorageError('provider_error', 'simulated delete failure');
      }
      store.delete(storageKey);
    },

    size(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
  };
}
