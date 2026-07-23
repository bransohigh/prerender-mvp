import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { domains, projects, sitemapSources, discoveredUrls } from '../../db/schema.js';
import { AppError } from '../../lib/app-error.js';
import { buildAuditMetadata } from '../../lib/audit-events.js';
import type { Metrics } from '../../lib/metrics.js';
import { insertAuditEventRow, runAuditedTransaction } from './audit-repository.js';
import type { SitemapDiscoveryCandidate } from '../../services/sitemap-discovery-service.js';
import type { SitemapFetchNode } from '../../services/sitemap-fetch-service.js';
import { countDiscoveredUrls } from '../../services/sitemap-fetch-service.js';
import type { SitemapSource, SitemapSourceType } from '../types.js';

// Checkpoint 3C-2 correction: network work (robots.txt fetch, sitemap
// fetch/decompress/parse — see sitemap-discovery-service.ts and
// sitemap-fetch-service.ts) never touches the database. Once that
// bounded, validated result is in hand, these two functions persist it
// and record the final audit event in ONE transaction — mutation and
// audit commit together, or neither does, exactly like the project/
// domain/api-key/invitation wiring. The route handler still records a
// short, standalone `*.started` event (via AuditService) before the
// network phase begins; if the network phase itself throws before
// reaching either function here, the `started` event is what remains as
// the historical record of the attempted operation — by design, not an
// oversight (see AUDIT_LOGGING.md).

export interface PersistSitemapDiscoveryParams {
  organizationId: string;
  domainId: string;
  candidates: SitemapDiscoveryCandidate[];
  actorUserId: string;
  requestId: string | null;
}

export async function persistSitemapDiscovery(
  db: Database,
  metrics: Metrics,
  params: PersistSitemapDiscoveryParams,
): Promise<SitemapSource[]> {
  return runAuditedTransaction(db, metrics, async (tx, setAuditedAction) => {
    const [domainRow] = await tx
      .select({ id: domains.id })
      .from(domains)
      .innerJoin(projects, eq(domains.projectId, projects.id))
      .where(and(eq(domains.id, params.domainId), eq(projects.organizationId, params.organizationId)))
      .limit(1);
    if (!domainRow) {
      throw new AppError('DOMAIN_NOT_FOUND', `Domain not found: ${params.domainId}`);
    }

    const created: SitemapSource[] = [];
    for (const candidate of params.candidates) {
      const [row] = await tx
        .insert(sitemapSources)
        .values({ domainId: params.domainId, url: candidate.url, normalizedUrl: candidate.normalizedUrl, type: candidate.type })
        .onConflictDoUpdate({
          target: [sitemapSources.domainId, sitemapSources.normalizedUrl],
          set: { updatedAt: new Date() },
        })
        .returning();
      created.push(row as SitemapSource);
    }

    setAuditedAction('sitemap.discovery.completed');
    await insertAuditEventRow(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorApiKeyId: null,
      action: 'sitemap.discovery.completed',
      targetType: 'domain',
      targetId: params.domainId,
      result: 'success',
      errorCode: null,
      requestId: params.requestId,
      metadata: buildAuditMetadata({ discoveredCount: created.length }),
    });

    return created;
  });
}

export interface PersistSitemapFetchParams {
  organizationId: string;
  domainId: string;
  sourceId: string;
  sourceType: SitemapSourceType;
  tree: SitemapFetchNode;
  actorUserId: string;
  requestId: string | null;
}

export interface PersistSitemapFetchResult {
  discoveredCount: number;
}

async function persistNode(tx: Database, domainId: string, sourceId: string, node: SitemapFetchNode): Promise<void> {
  const now = new Date();
  if (node.outcome.status === 'success') {
    await tx
      .update(sitemapSources)
      .set({ status: 'success', lastFetchedAt: now, lastHttpStatus: 200, discoveredUrlCount: node.outcome.urls.length, updatedAt: now })
      .where(eq(sitemapSources.id, sourceId));

    for (const url of node.outcome.urls) {
      await tx
        .insert(discoveredUrls)
        .values({
          domainId,
          sitemapSourceId: sourceId,
          url: url.url,
          normalizedUrl: url.normalizedUrl,
          path: url.path,
          lastmod: url.lastmod,
          priority: url.priority,
          changefreq: url.changefreq,
          lastDiscoveredAt: now,
        })
        .onConflictDoUpdate({
          target: [discoveredUrls.domainId, discoveredUrls.normalizedUrl],
          set: {
            sitemapSourceId: sourceId,
            lastmod: url.lastmod,
            priority: url.priority,
            changefreq: url.changefreq,
            lastDiscoveredAt: now,
            updatedAt: now,
          },
        });
    }
  } else {
    await tx
      .update(sitemapSources)
      .set({ status: 'failed', lastFetchedAt: now, lastErrorCode: node.outcome.errorCode, updatedAt: now })
      .where(eq(sitemapSources.id, sourceId));
  }

  for (const child of node.children) {
    const [childRow] = await tx
      .insert(sitemapSources)
      .values({ domainId, url: child.url, normalizedUrl: child.normalizedUrl, type: 'sitemap' })
      .onConflictDoUpdate({
        target: [sitemapSources.domainId, sitemapSources.normalizedUrl],
        set: { updatedAt: new Date() },
      })
      .returning({ id: sitemapSources.id });
    await persistNode(tx, domainId, childRow!.id, child);
  }
}

export interface PersistSitemapFetchFailureParams {
  organizationId: string;
  sourceId: string;
  sourceType: SitemapSourceType;
  errorCode: string;
  actorUserId: string;
  requestId: string | null;
}

// The top-level (originally requested) source's own fetch/parse call
// itself threw — e.g. the network request failed outright, or the
// response wasn't valid sitemap XML at all — so there is no tree to
// persist. The source's final 'failed' status and the
// sitemap.fetch.failed audit event still commit together in one
// transaction, exactly like the success path.
export async function persistSitemapFetchFailure(
  db: Database,
  metrics: Metrics,
  params: PersistSitemapFetchFailureParams,
): Promise<void> {
  await runAuditedTransaction(db, metrics, async (tx, setAuditedAction) => {
    const now = new Date();
    await tx
      .update(sitemapSources)
      .set({ status: 'failed', lastFetchedAt: now, lastErrorCode: params.errorCode, updatedAt: now })
      .where(eq(sitemapSources.id, params.sourceId));

    setAuditedAction('sitemap.fetch.failed');
    await insertAuditEventRow(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorApiKeyId: null,
      action: 'sitemap.fetch.failed',
      targetType: 'sitemap_source',
      targetId: params.sourceId,
      result: 'success',
      errorCode: null,
      requestId: params.requestId,
      metadata: buildAuditMetadata({ sitemapType: params.sourceType, reasonCode: params.errorCode }),
    });

    return null;
  });
}

export async function persistSitemapFetch(
  db: Database,
  metrics: Metrics,
  params: PersistSitemapFetchParams,
): Promise<PersistSitemapFetchResult> {
  return runAuditedTransaction(db, metrics, async (tx, setAuditedAction) => {
    await persistNode(tx, params.domainId, params.sourceId, params.tree);

    const discoveredCount = countDiscoveredUrls(params.tree);
    const action = params.tree.outcome.status === 'success' ? 'sitemap.fetch.completed' : 'sitemap.fetch.failed';
    setAuditedAction(action);
    await insertAuditEventRow(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorApiKeyId: null,
      action,
      targetType: 'sitemap_source',
      targetId: params.sourceId,
      result: 'success',
      errorCode: null,
      requestId: params.requestId,
      metadata: buildAuditMetadata(
        params.tree.outcome.status === 'success'
          ? { sitemapType: params.sourceType, discoveredCount }
          : { sitemapType: params.sourceType, reasonCode: params.tree.outcome.errorCode },
      ),
    });

    return { discoveredCount };
  });
}
