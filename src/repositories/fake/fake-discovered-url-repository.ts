import { randomUUID } from 'node:crypto';
import type {
  DiscoveredUrl,
  DiscoveredUrlRepository,
  UpsertDiscoveredUrlInput,
  PageResult,
} from '../types.js';

export function createFakeDiscoveredUrlRepository(): DiscoveredUrlRepository {
  const store = new Map<string, DiscoveredUrl>();

  function keyFor(domainId: string, normalizedUrl: string): string {
    return `${domainId}::${normalizedUrl}`;
  }

  return {
    async upsertMany(inputs: UpsertDiscoveredUrlInput[]): Promise<number> {
      const now = new Date();
      let count = 0;
      for (const input of inputs) {
        const key = keyFor(input.domainId, input.normalizedUrl);
        const existing = [...store.values()].find(
          (u) => u.domainId === input.domainId && u.normalizedUrl === input.normalizedUrl,
        );
        if (existing) {
          store.set(existing.id, {
            ...existing,
            sitemapSourceId: input.sitemapSourceId,
            lastmod: input.lastmod ?? existing.lastmod,
            priority: input.priority ?? existing.priority,
            changefreq: input.changefreq ?? existing.changefreq,
            lastDiscoveredAt: now,
            updatedAt: now,
          });
        } else {
          const record: DiscoveredUrl = {
            id: randomUUID(),
            domainId: input.domainId,
            sitemapSourceId: input.sitemapSourceId,
            url: input.url,
            normalizedUrl: input.normalizedUrl,
            path: input.path,
            status: 'active',
            lastmod: input.lastmod ?? null,
            priority: input.priority ?? null,
            changefreq: input.changefreq ?? null,
            firstDiscoveredAt: now,
            lastDiscoveredAt: now,
            createdAt: now,
            updatedAt: now,
          };
          store.set(record.id, record);
        }
        count++;
        void key;
      }
      return count;
    },

    async countByDomain(domainId: string): Promise<number> {
      return [...store.values()].filter((u) => u.domainId === domainId).length;
    },

    async listByDomain(domainId, options): Promise<PageResult<DiscoveredUrl>> {
      const all = [...store.values()]
        .filter((u) => u.domainId === domainId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const startIndex = options.cursor
        ? all.findIndex((u) => u.id === options.cursor) + 1
        : 0;
      const page = all.slice(startIndex, startIndex + options.limit);
      const nextCursor =
        startIndex + options.limit < all.length ? page[page.length - 1]?.id ?? null : null;
      return { items: page, nextCursor };
    },
  };
}
