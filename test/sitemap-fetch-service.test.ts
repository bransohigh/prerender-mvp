import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildSitemapFetchTree, countDiscoveredUrls, SITEMAP_FETCH_LIMITS } from '../src/services/sitemap-fetch-service.js';
import type { SafeFetchResult, safeFetch } from '../src/lib/safe-http-client.js';
import type { Domain } from '../src/repositories/types.js';

function makeDomain(): Domain {
  const now = new Date();
  return {
    id: randomUUID(),
    projectId: randomUUID(),
    hostname: 'example.com',
    normalizedHostname: 'example.com',
    status: 'verified',
    verificationMethod: 'dns_txt',
    verificationTokenHash: 'hash',
    verifiedAt: now,
    lastVerificationAttemptAt: now,
    verificationFailureCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function fakeFetch(handler: (url: string) => SafeFetchResult): typeof safeFetch {
  return (async (url: string) => handler(url)) as typeof safeFetch;
}

function freshState() {
  return { nestedCount: 0, remainingUrlBudget: SITEMAP_FETCH_LIMITS.maxTotalUrlsPerDomain };
}

const URLSET_XML = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`;

const INDEX_XML = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/part-1.xml</loc></sitemap>
</sitemapindex>`;

describe('buildSitemapFetchTree (pure network+parse, no database access)', () => {
  it('parses a plain urlset into the tree', async () => {
    const domain = makeDomain();
    const fetchImpl = fakeFetch(() => ({ status: 200, body: Buffer.from(URLSET_XML), headers: {} }));

    const tree = await buildSitemapFetchTree(domain, 'https://example.com/sitemap.xml', 0, freshState(), { fetchImpl });

    expect(tree.outcome.status).toBe('success');
    expect(countDiscoveredUrls(tree)).toBe(2);
    expect(tree.children).toHaveLength(0);
  });

  it('recurses into a sitemap index and captures nested sitemaps as children', async () => {
    const domain = makeDomain();
    const fetchImpl = fakeFetch((url) => {
      if (url === 'https://example.com/sitemap_index.xml') {
        return { status: 200, body: Buffer.from(INDEX_XML), headers: {} };
      }
      return { status: 200, body: Buffer.from(URLSET_XML), headers: {} };
    });

    const tree = await buildSitemapFetchTree(domain, 'https://example.com/sitemap_index.xml', 0, freshState(), { fetchImpl });

    expect(countDiscoveredUrls(tree)).toBe(2);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]!.url).toBe('https://example.com/part-1.xml');
    expect(tree.children[0]!.outcome.status).toBe('success');
  });

  it('handles gzip-compressed sitemap responses', async () => {
    const domain = makeDomain();
    const gzipped = zlib.gzipSync(Buffer.from(URLSET_XML));
    const fetchImpl = fakeFetch(() => ({ status: 200, body: gzipped, headers: { 'content-encoding': 'gzip' } }));

    const tree = await buildSitemapFetchTree(domain, 'https://example.com/sitemap.xml', 0, freshState(), { fetchImpl });
    expect(countDiscoveredUrls(tree)).toBe(2);
  });

  it('detects gzip by magic bytes even without a content-encoding header', async () => {
    const domain = makeDomain();
    const gzipped = zlib.gzipSync(Buffer.from(URLSET_XML));
    const fetchImpl = fakeFetch(() => ({ status: 200, body: gzipped, headers: {} }));

    const tree = await buildSitemapFetchTree(domain, 'https://example.com/sitemap.xml.gz', 0, freshState(), { fetchImpl });
    expect(countDiscoveredUrls(tree)).toBe(2);
  });

  it('rejects URLs from a different domain silently (skips, does not throw)', async () => {
    const domain = makeDomain();
    const mixedXml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/ok</loc></url>
      <url><loc>https://evil.com/bad</loc></url>
    </urlset>`;
    const fetchImpl = fakeFetch(() => ({ status: 200, body: Buffer.from(mixedXml), headers: {} }));

    const tree = await buildSitemapFetchTree(domain, 'https://example.com/sitemap.xml', 0, freshState(), { fetchImpl });
    expect(countDiscoveredUrls(tree)).toBe(1);
  });

  it('throws SITEMAP_FETCH_FAILED on non-200 status at the top level', async () => {
    const domain = makeDomain();
    const fetchImpl = fakeFetch(() => ({ status: 500, body: Buffer.from(''), headers: {} }));

    await expect(
      buildSitemapFetchTree(domain, 'https://example.com/sitemap.xml', 0, freshState(), { fetchImpl }),
    ).rejects.toMatchObject({ code: 'SITEMAP_FETCH_FAILED' });
  });

  it('a nested (non-top-level) fetch failure is captured as a failed child node, not thrown', async () => {
    const domain = makeDomain();
    const fetchImpl = fakeFetch((url) => {
      if (url === 'https://example.com/sitemap_index.xml') {
        return { status: 200, body: Buffer.from(INDEX_XML), headers: {} };
      }
      return { status: 500, body: Buffer.from(''), headers: {} };
    });

    const tree = await buildSitemapFetchTree(domain, 'https://example.com/sitemap_index.xml', 0, freshState(), { fetchImpl });
    expect(tree.outcome.status).toBe('success');
    expect(tree.children[0]!.outcome.status).toBe('failed');
  });

  it('rejects DOCTYPE/XXE payloads via SITEMAP_FETCH_FAILED', async () => {
    const domain = makeDomain();
    const xxe = `<!DOCTYPE urlset [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/&xxe;</loc></url></urlset>`;
    const fetchImpl = fakeFetch(() => ({ status: 200, body: Buffer.from(xxe), headers: {} }));

    await expect(
      buildSitemapFetchTree(domain, 'https://example.com/sitemap.xml', 0, freshState(), { fetchImpl }),
    ).rejects.toMatchObject({ code: 'SITEMAP_FETCH_FAILED' });
  });

  it('throws SITEMAP_LIMIT_EXCEEDED when the per-domain URL budget is already exhausted', async () => {
    const domain = makeDomain();
    const fetchImpl = fakeFetch(() => ({ status: 200, body: Buffer.from(URLSET_XML), headers: {} }));

    await expect(
      buildSitemapFetchTree(domain, 'https://example.com/sitemap.xml', 0, { nestedCount: 0, remainingUrlBudget: 0 }, { fetchImpl }),
    ).rejects.toMatchObject({ code: 'SITEMAP_LIMIT_EXCEEDED' });
  });

  it('throws SITEMAP_LIMIT_EXCEEDED when recursion depth exceeds the limit', async () => {
    const domain = makeDomain();
    const fetchImpl = fakeFetch(() => ({ status: 200, body: Buffer.from(URLSET_XML), headers: {} }));

    await expect(
      buildSitemapFetchTree(domain, 'https://example.com/sitemap.xml', SITEMAP_FETCH_LIMITS.maxIndexDepth + 1, freshState(), { fetchImpl }),
    ).rejects.toMatchObject({ code: 'SITEMAP_LIMIT_EXCEEDED' });
  });
});
