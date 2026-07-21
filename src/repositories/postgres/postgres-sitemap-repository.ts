import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { sitemapSources } from '../../db/schema.js';
import type {
  SitemapSource,
  SitemapRepository,
  UpsertSitemapSourceInput,
  RecordSitemapFetchInput,
} from '../types.js';

export function createPostgresSitemapRepository(db: Database): SitemapRepository {
  return {
    async upsert(input: UpsertSitemapSourceInput): Promise<SitemapSource> {
      const [row] = await db
        .insert(sitemapSources)
        .values({
          domainId: input.domainId,
          url: input.url,
          normalizedUrl: input.normalizedUrl,
          type: input.type,
        })
        .onConflictDoUpdate({
          target: [sitemapSources.domainId, sitemapSources.normalizedUrl],
          set: { updatedAt: new Date() },
        })
        .returning();
      return row as SitemapSource;
    },

    async findById(id: string): Promise<SitemapSource | null> {
      const [row] = await db.select().from(sitemapSources).where(eq(sitemapSources.id, id)).limit(1);
      return (row as SitemapSource) ?? null;
    },

    async listByDomain(domainId: string): Promise<SitemapSource[]> {
      const rows = await db
        .select()
        .from(sitemapSources)
        .where(eq(sitemapSources.domainId, domainId));
      return rows as SitemapSource[];
    },

    async recordFetchResult(id: string, input: RecordSitemapFetchInput): Promise<SitemapSource | null> {
      const set: Record<string, unknown> = {
        status: input.status,
        lastFetchedAt: new Date(),
        updatedAt: new Date(),
      };
      if (input.lastHttpStatus !== undefined) set.lastHttpStatus = input.lastHttpStatus;
      if (input.lastErrorCode !== undefined) set.lastErrorCode = input.lastErrorCode;
      if (input.etag !== undefined) set.etag = input.etag;
      if (input.lastModified !== undefined) set.lastModified = input.lastModified;
      if (input.discoveredUrlCount !== undefined) set.discoveredUrlCount = input.discoveredUrlCount;

      const [row] = await db
        .update(sitemapSources)
        .set(set)
        .where(and(eq(sitemapSources.id, id)))
        .returning();
      return (row as SitemapSource) ?? null;
    },
  };
}
