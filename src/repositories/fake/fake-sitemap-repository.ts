import { randomUUID } from 'node:crypto';
import type {
  SitemapSource,
  SitemapRepository,
  UpsertSitemapSourceInput,
  RecordSitemapFetchInput,
} from '../types.js';

export function createFakeSitemapRepository(): SitemapRepository {
  const store = new Map<string, SitemapSource>();

  return {
    async upsert(input: UpsertSitemapSourceInput): Promise<SitemapSource> {
      const existing = [...store.values()].find(
        (s) => s.domainId === input.domainId && s.normalizedUrl === input.normalizedUrl,
      );
      if (existing) return existing;
      const now = new Date();
      const source: SitemapSource = {
        id: randomUUID(),
        domainId: input.domainId,
        url: input.url,
        normalizedUrl: input.normalizedUrl,
        type: input.type,
        status: 'pending',
        lastFetchedAt: null,
        lastHttpStatus: null,
        lastErrorCode: null,
        etag: null,
        lastModified: null,
        discoveredUrlCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      store.set(source.id, source);
      return source;
    },

    async findById(id: string): Promise<SitemapSource | null> {
      return store.get(id) ?? null;
    },

    async listByDomain(domainId: string): Promise<SitemapSource[]> {
      return [...store.values()].filter((s) => s.domainId === domainId);
    },

    async recordFetchResult(id: string, input: RecordSitemapFetchInput): Promise<SitemapSource | null> {
      const source = store.get(id);
      if (!source) return null;
      const updated: SitemapSource = {
        ...source,
        status: input.status,
        lastFetchedAt: new Date(),
        lastHttpStatus: input.lastHttpStatus ?? source.lastHttpStatus,
        lastErrorCode: input.lastErrorCode ?? null,
        etag: input.etag ?? source.etag,
        lastModified: input.lastModified ?? source.lastModified,
        discoveredUrlCount: input.discoveredUrlCount ?? source.discoveredUrlCount,
        updatedAt: new Date(),
      };
      store.set(id, updated);
      return updated;
    },
  };
}
