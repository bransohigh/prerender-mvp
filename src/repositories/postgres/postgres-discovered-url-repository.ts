import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { discoveredUrls } from '../../db/schema.js';
import type {
  DiscoveredUrl,
  DiscoveredUrlRepository,
  UpsertDiscoveredUrlInput,
  PageResult,
} from '../types.js';

export function createPostgresDiscoveredUrlRepository(db: Database): DiscoveredUrlRepository {
  return {
    async upsertMany(inputs: UpsertDiscoveredUrlInput[]): Promise<number> {
      if (inputs.length === 0) return 0;
      let count = 0;
      // Batched in a single transaction so a partial failure doesn't leave
      // half the sitemap's URLs upserted.
      await db.transaction(async (tx) => {
        for (const input of inputs) {
          await tx
            .insert(discoveredUrls)
            .values({
              domainId: input.domainId,
              sitemapSourceId: input.sitemapSourceId,
              url: input.url,
              normalizedUrl: input.normalizedUrl,
              path: input.path,
              lastmod: input.lastmod ?? null,
              priority: input.priority ?? null,
              changefreq: input.changefreq ?? null,
              lastDiscoveredAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [discoveredUrls.domainId, discoveredUrls.normalizedUrl],
              set: {
                sitemapSourceId: input.sitemapSourceId,
                lastmod: input.lastmod ?? null,
                priority: input.priority ?? null,
                changefreq: input.changefreq ?? null,
                lastDiscoveredAt: new Date(),
                updatedAt: new Date(),
              },
            });
          count++;
        }
      });
      return count;
    },

    async countByDomain(domainId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(discoveredUrls)
        .where(eq(discoveredUrls.domainId, domainId));
      return row?.count ?? 0;
    },

    async listByDomain(domainId, options): Promise<PageResult<DiscoveredUrl>> {
      const conditions = [eq(discoveredUrls.domainId, domainId)];
      if (options.cursor) {
        conditions.push(gt(discoveredUrls.id, options.cursor));
      }
      const rows = await db
        .select()
        .from(discoveredUrls)
        .where(and(...conditions))
        .orderBy(asc(discoveredUrls.id))
        .limit(options.limit + 1);

      const hasMore = rows.length > options.limit;
      const page = rows.slice(0, options.limit) as DiscoveredUrl[];
      return { items: page, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null };
    },
  };
}
