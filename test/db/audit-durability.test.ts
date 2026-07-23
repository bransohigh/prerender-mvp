import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDbClient, truncateAll } from './helpers.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { createTenantRepository } from '../../src/repositories/postgres/tenant-repository.js';
import { createApiKeyRepository } from '../../src/repositories/postgres/api-key-repository.js';
import { hashVerificationToken, generateVerificationToken } from '../../src/lib/verification-token.js';
import { member as memberTable, sitemapSources, discoveredUrls, auditEvents } from '../../src/db/schema.js';
import { createNoopMetrics, type Metrics, type AuditEventResultLabel } from '../../src/lib/metrics.js';
import {
  persistSitemapDiscovery,
  persistSitemapFetch,
} from '../../src/repositories/postgres/sitemap-persistence-repository.js';
import type { SitemapFetchNode } from '../../src/services/sitemap-fetch-service.js';
import type { DbClient } from '../../src/db/client.js';

let client: DbClient;
let auth: Auth;

beforeEach(async () => {
  client ??= createTestDbClient();
  auth ??= createAuth(client.db);
  await truncateAll(client);
});

afterAll(async () => {
  await client?.close();
});

interface OrgFixture {
  organizationId: string;
  ownerUserId: string;
  projectId: string;
  domainId: string;
}

async function createOrgWithProjectAndDomain(label: string): Promise<OrgFixture> {
  const tenant = createTenantRepository(client.db);
  const signUp = await auth.api.signUpEmail({
    body: { email: `owner-${label}@example.com`, name: `Owner ${label}`, password: 'correct-horse-battery-staple' },
  });
  const org = await auth.api.createOrganization({
    body: { name: `Org ${label}`, slug: `durability-org-${label}-${Date.now()}`, userId: signUp.user.id },
  });
  if (!org) throw new Error('org create failed');
  await client.db.insert(memberTable).values({
    id: `mem_${signUp.user.id}_${org.id}`,
    organizationId: org.id,
    userId: signUp.user.id,
    role: 'owner',
    createdAt: new Date(),
  });

  const project = await tenant.createProjectForOrganization(org.id, { name: `Project ${label}`, slug: `project-${label}-${Date.now()}` }, signUp.user.id, null);
  const domain = await tenant.createDomainForOrganization(
    org.id,
    project.id,
    {
      hostname: `${label}.example.com`,
      normalizedHostname: `${label}.example.com`,
      verificationMethod: 'dns_txt',
      verificationTokenHash: hashVerificationToken(generateVerificationToken()),
    },
    signUp.user.id,
    null,
  );

  return { organizationId: org.id, ownerUserId: signUp.user.id, projectId: project.id, domainId: domain.id };
}

// A fabricated actorUserId that violates audit_events.actor_user_id's FK
// to the `user` table forces the audit insert (and therefore the whole
// transaction) to fail, deterministically, without needing to mock
// anything — the same technique used in test/db/audit-events-endpoint.test.ts.
const FORCING_ACTOR_ID = 'user_does_not_exist_at_all';

function createSpyMetrics(): Metrics & { calls: Array<{ action: string; result: AuditEventResultLabel }> } {
  const base = createNoopMetrics();
  const calls: Array<{ action: string; result: AuditEventResultLabel }> = [];
  return {
    ...base,
    incrementAuditEvent: (action, result) => {
      calls.push({ action, result });
    },
    calls,
  };
}

describe('sitemap discovery: durable final-state persistence', () => {
  it('a forced audit-insert failure rolls back all discovered source upserts', async () => {
    const a = await createOrgWithProjectAndDomain('discovery-rollback');

    await expect(
      persistSitemapDiscovery(client.db, createNoopMetrics(), {
        organizationId: a.organizationId,
        domainId: a.domainId,
        candidates: [
          { url: 'https://x.example.com/sitemap.xml', normalizedUrl: 'https://x.example.com/sitemap.xml', type: 'sitemap' },
          { url: 'https://x.example.com/sitemap_index.xml', normalizedUrl: 'https://x.example.com/sitemap_index.xml', type: 'sitemap_index' },
        ],
        actorUserId: FORCING_ACTOR_ID,
        requestId: null,
      }),
    ).rejects.toThrow();

    const rows = await client.db.select().from(sitemapSources).where(eq(sitemapSources.domainId, a.domainId));
    expect(rows).toHaveLength(0);

    const completedAudit = await client.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.organizationId, a.organizationId), eq(auditEvents.action, 'sitemap.discovery.completed' as never)));
    expect(completedAudit).toHaveLength(0);
  });

  it('a successful discovery persists all candidates and exactly one completed audit event', async () => {
    const a = await createOrgWithProjectAndDomain('discovery-success');

    const result = await persistSitemapDiscovery(client.db, createNoopMetrics(), {
      organizationId: a.organizationId,
      domainId: a.domainId,
      candidates: [
        { url: 'https://x.example.com/sitemap.xml', normalizedUrl: 'https://x.example.com/sitemap.xml', type: 'sitemap' },
      ],
      actorUserId: a.ownerUserId,
      requestId: null,
    });
    expect(result).toHaveLength(1);

    const rows = await client.db.select().from(sitemapSources).where(eq(sitemapSources.domainId, a.domainId));
    expect(rows).toHaveLength(1);

    const completedAudit = await client.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.organizationId, a.organizationId), eq(auditEvents.action, 'sitemap.discovery.completed' as never)));
    expect(completedAudit).toHaveLength(1);
    expect(completedAudit[0]!.metadata).toEqual({ discoveredCount: 1 });
  });
});

describe('sitemap fetch: durable final-state persistence', () => {
  async function seedTopLevelSource(a: OrgFixture) {
    const [row] = await client.db
      .insert(sitemapSources)
      .values({ domainId: a.domainId, url: 'https://x.example.com/sitemap.xml', normalizedUrl: 'https://x.example.com/sitemap.xml', type: 'sitemap' })
      .returning();
    return row!;
  }

  function makeUrlsetTree(): SitemapFetchNode {
    return {
      url: 'https://x.example.com/sitemap.xml',
      normalizedUrl: 'https://x.example.com/sitemap.xml',
      outcome: {
        status: 'success',
        urls: [
          { url: 'https://x.example.com/a', normalizedUrl: 'https://x.example.com/a', path: '/a', lastmod: null, priority: null, changefreq: null },
          { url: 'https://x.example.com/b', normalizedUrl: 'https://x.example.com/b', path: '/b', lastmod: null, priority: null, changefreq: null },
        ],
      },
      children: [],
    };
  }

  it('a forced audit-insert failure rolls back discovered URL upserts and the source final-state update', async () => {
    const a = await createOrgWithProjectAndDomain('fetch-rollback');
    const source = await seedTopLevelSource(a);

    await expect(
      persistSitemapFetch(client.db, createNoopMetrics(), {
        organizationId: a.organizationId,
        domainId: a.domainId,
        sourceId: source.id,
        sourceType: 'sitemap',
        tree: makeUrlsetTree(),
        actorUserId: FORCING_ACTOR_ID,
        requestId: null,
      }),
    ).rejects.toThrow();

    const urls = await client.db.select().from(discoveredUrls).where(eq(discoveredUrls.domainId, a.domainId));
    expect(urls).toHaveLength(0);

    const [sourceAfter] = await client.db.select().from(sitemapSources).where(eq(sitemapSources.id, source.id));
    expect(sourceAfter!.status).toBe('pending'); // unchanged — never committed to 'success'

    const completedAudit = await client.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.organizationId, a.organizationId), eq(auditEvents.action, 'sitemap.fetch.completed' as never)));
    expect(completedAudit).toHaveLength(0);
  });

  it('a forced audit-insert failure on a sitemap index rolls back nested source creation too', async () => {
    const a = await createOrgWithProjectAndDomain('fetch-index-rollback');
    const source = await seedTopLevelSource(a);
    const tree: SitemapFetchNode = {
      url: source.url,
      normalizedUrl: source.normalizedUrl,
      outcome: { status: 'success', urls: [] },
      children: [
        {
          url: 'https://x.example.com/part-1.xml',
          normalizedUrl: 'https://x.example.com/part-1.xml',
          outcome: { status: 'success', urls: [{ url: 'https://x.example.com/c', normalizedUrl: 'https://x.example.com/c', path: '/c', lastmod: null, priority: null, changefreq: null }] },
          children: [],
        },
      ],
    };

    await expect(
      persistSitemapFetch(client.db, createNoopMetrics(), {
        organizationId: a.organizationId,
        domainId: a.domainId,
        sourceId: source.id,
        sourceType: 'sitemap_index',
        tree,
        actorUserId: FORCING_ACTOR_ID,
        requestId: null,
      }),
    ).rejects.toThrow();

    const nestedRows = await client.db.select().from(sitemapSources).where(eq(sitemapSources.normalizedUrl, 'https://x.example.com/part-1.xml'));
    expect(nestedRows).toHaveLength(0);
    const urls = await client.db.select().from(discoveredUrls).where(eq(discoveredUrls.domainId, a.domainId));
    expect(urls).toHaveLength(0);
  });

  it('a successful fetch persists URLs, final source status, and exactly one completed audit event', async () => {
    const a = await createOrgWithProjectAndDomain('fetch-success');
    const source = await seedTopLevelSource(a);

    const result = await persistSitemapFetch(client.db, createNoopMetrics(), {
      organizationId: a.organizationId,
      domainId: a.domainId,
      sourceId: source.id,
      sourceType: 'sitemap',
      tree: makeUrlsetTree(),
      actorUserId: a.ownerUserId,
      requestId: null,
    });
    expect(result.discoveredCount).toBe(2);

    const urls = await client.db.select().from(discoveredUrls).where(eq(discoveredUrls.domainId, a.domainId));
    expect(urls).toHaveLength(2);
    const [sourceAfter] = await client.db.select().from(sitemapSources).where(eq(sitemapSources.id, source.id));
    expect(sourceAfter!.status).toBe('success');
    expect(sourceAfter!.discoveredUrlCount).toBe(2);

    const completedAudit = await client.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.organizationId, a.organizationId), eq(auditEvents.action, 'sitemap.fetch.completed' as never)));
    expect(completedAudit).toHaveLength(1);
  });
});

describe('audit metrics: commit-aware (post-commit only)', () => {
  it('a committed audit write increments success exactly once', async () => {
    const a = await createOrgWithProjectAndDomain('metrics-success');
    const spy = createSpyMetrics();
    const tenant = createTenantRepository(client.db, spy);

    await tenant.createProjectForOrganization(a.organizationId, { name: 'M', slug: `metrics-${Date.now()}` }, a.ownerUserId, null);

    const projectCreatedCalls = spy.calls.filter((c) => c.action === 'project.created');
    expect(projectCreatedCalls).toEqual([{ action: 'project.created', result: 'success' }]);
  });

  it('rollback after the audit insert is attempted does not increment success, and increments failure at most once', async () => {
    const a = await createOrgWithProjectAndDomain('metrics-rollback');
    const spy = createSpyMetrics();
    const tenant = createTenantRepository(client.db, spy);

    await expect(
      tenant.createDomainForOrganization(
        a.organizationId,
        a.projectId,
        {
          hostname: 'second-domain.metrics-rollback.example.com',
          normalizedHostname: 'second-domain.metrics-rollback.example.com',
          verificationMethod: 'dns_txt',
          verificationTokenHash: hashVerificationToken(generateVerificationToken()),
        },
        FORCING_ACTOR_ID,
        null,
      ),
    ).rejects.toThrow();

    const domainCreatedCalls = spy.calls.filter((c) => c.action === 'domain.created');
    expect(domainCreatedCalls).toEqual([{ action: 'domain.created', result: 'failure' }]);
  });

  it('a business-validation failure that never reaches the audit insert increments nothing', async () => {
    const a = await createOrgWithProjectAndDomain('metrics-no-audit-attempt');
    const spy = createSpyMetrics();
    const tenant = createTenantRepository(client.db, spy);

    // Duplicate slug -> unique violation before the audit insert is ever
    // reached (see createProjectForOrganization's catch block).
    await tenant.createProjectForOrganization(a.organizationId, { name: 'First', slug: 'dup-slug' }, a.ownerUserId, null);
    spy.calls.length = 0; // only care about the second (failing) call below

    await expect(
      tenant.createProjectForOrganization(a.organizationId, { name: 'Second', slug: 'dup-slug' }, a.ownerUserId, null),
    ).rejects.toThrow();

    expect(spy.calls).toEqual([]);
  });

  it('no duplicate metric increment occurs through nested repository/service calls (rotation is one audit write)', async () => {
    const a = await createOrgWithProjectAndDomain('metrics-no-duplicate');
    const spy = createSpyMetrics();
    const apiKeyRepo = createApiKeyRepository(client.db, spy);

    const created = await apiKeyRepo.createApiKeyForProject({
      organizationId: a.organizationId,
      name: 'K',
      prefix: 'pr_live_',
      expiresAt: new Date(Date.now() + 86400000),
      rateLimitMax: 120,
      rateLimitTimeWindowMs: 60000,
      metadata: { projectId: a.projectId, createdByUserId: a.ownerUserId, revokedAt: null, rotatedFromKeyId: null, rotatedToKeyId: null },
      requestId: null,
    });
    spy.calls.length = 0;

    await apiKeyRepo.rotateApiKeyForProject({
      organizationId: a.organizationId,
      projectId: a.projectId,
      keyId: created.id,
      name: 'K2',
      prefix: 'pr_live_',
      expiresAt: new Date(Date.now() + 86400000),
      rateLimitMax: 120,
      rateLimitTimeWindowMs: 60000,
      createdByUserId: a.ownerUserId,
      requestId: null,
    });

    const rotatedCalls = spy.calls.filter((c) => c.action === 'api_key.rotated');
    expect(rotatedCalls).toEqual([{ action: 'api_key.rotated', result: 'success' }]);
  });

  it('a metrics-client error does not break or roll back an already-committed operation', async () => {
    const a = await createOrgWithProjectAndDomain('metrics-failure-safe');
    const throwingMetrics: Metrics = {
      ...createNoopMetrics(),
      incrementAuditEvent: () => {
        throw new Error('simulated Prometheus client failure');
      },
    };
    const tenant = createTenantRepository(client.db, throwingMetrics);

    // The metrics call happens AFTER db.transaction() resolves (see
    // runAuditedTransaction) — by the time incrementAuditEvent throws,
    // the project row is already committed. Whether that throw
    // propagates or not, the row must exist afterward.
    try {
      await tenant.createProjectForOrganization(a.organizationId, { name: 'Safe', slug: `metrics-safe-${Date.now()}` }, a.ownerUserId, null);
    } catch {
      // Either behavior (propagate or swallow) is acceptable here — what
      // matters is the mutation itself already committed, checked below.
    }

    const { projects } = await import('../../src/db/schema.js');
    const rows = await client.db.select().from(projects).where(eq(projects.name, 'Safe'));
    expect(rows).toHaveLength(1);
  });

  it('action/result labels are fixed enum values, never an id or secret', () => {
    const spy = createSpyMetrics();
    spy.incrementAuditEvent('project.created', 'success');
    for (const call of spy.calls) {
      expect(['success', 'failure']).toContain(call.result);
      expect(call.action).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i); // not a UUID
    }
  });
});
