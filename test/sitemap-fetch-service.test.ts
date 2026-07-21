import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFakeSitemapRepository } from '../src/repositories/fake/fake-sitemap-repository.js';
import { createFakeDiscoveredUrlRepository } from '../src/repositories/fake/fake-discovered-url-repository.js';
import { fetchAndParseSitemapSource } from '../src/services/sitemap-fetch-service.js';
import type { SafeFetchResult, safeFetch } from '../src/lib/safe-http-client.js';
import type { Domain, SitemapSource } from '../src/repositories/types.js';

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

function makeSource(domainId: string, overrides: Partial<SitemapSource> = {}): SitemapSource {
  const now = new Date();
  return {
    id: randomUUID(),
    domainId,
    url: 'https://example.com/sitemap.xml',
    normalizedUrl: 'https://example.com/sitemap.xml',
    type: 'sitemap',
    status: 'pending',
    lastFetchedAt: null,
    lastHttpStatus: null,
    lastErrorCode: null,
    etag: null,
    lastModified: null,
    discoveredUrlCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakeFetch(handler: (url: string) => SafeFetchResult): typeof safeFetch {
  return (async (url: string) => handler(url)) as typeof safeFetch;
}

const URLSET_XML = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`;

const INDEX_XML = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/part-1.xml</loc></sitemap>
</sitemapindex>`;

describe('fetchAndParseSitemapSource', () => {
  it('parses a plain urlset and stores discovered URLs', async () => {
    const domain = makeDomain();
    const sitemapRepository = createFakeSitemapRepository();
    const discoveredUrlRepository = createFakeDiscoveredUrlRepository();
    const source = await sitemapRepository.upsert({
      domainId: domain.id,
      url: 'https://example.com/sitemap.xml',
      normalizedUrl: 'https://example.com/sitemap.xml',
      type: 'sitemap',
    });

    const fetchImpl = fakeFetch(() => ({ status: 200, body: Buffer.from(URLSET_XML), headers: {} }));
    const outcome = await fetchAndParseSitemapSource(domain, source, sitemapRepository, discoveredUrlRepository, {
      fetchImpl,
    });

    expect(outcome.discoveredCount).toBe(2);
    expect(await discoveredUrlRepository.countByDomain(domain.id)).toBe(2);
  });

  it('recurses into a sitemap index and fetches nested sitemaps', async () => {
    const domain = makeDomain();
    const sitemapRepository = createFakeSitemapRepository();
    const discoveredUrlRepository = createFakeDiscoveredUrlRepository();
    const source = makeSource(domain.id, {
      url: 'https://example.com/sitemap_index.xml',
      normalizedUrl: 'https://example.com/sitemap_index.xml',
      type: 'sitemap_index',
    });
    await sitemapRepository.upsert({
      domainId: domain.id,
      url: source.url,
      normalizedUrl: source.normalizedUrl,
      type: 'sitemap_index',
    });

    const fetchImpl = fakeFetch((url) => {
      if (url === 'https://example.com/sitemap_index.xml') {
        return { status: 200, body: Buffer.from(INDEX_XML), headers: {} };
      }
      return { status: 200, body: Buffer.from(URLSET_XML), headers: {} };
    });

    const outcome = await fetchAndParseSitemapSource(domain, source, sitemapRepository, discoveredUrlRepository, {
      fetchImpl,
    });
    expect(outcome.discoveredCount).toBe(2);

    const nested = await sitemapRepository.listByDomain(domain.id);
    expect(nested.some((s) => s.url === 'https://example.com/part-1.xml')).toBe(true);
  });

  it('handles gzip-compressed sitemap responses', async () => {
    const domain = makeDomain();
    const sitemapRepository = createFakeSitemapRepository();
    const discoveredUrlRepository = createFakeDiscoveredUrlRepository();
    const source = makeSource(domain.id);
    const gzipped = zlib.gzipSync(Buffer.from(URLSET_XML));

    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: gzipped,
      headers: { 'content-encoding': 'gzip' },
    }));

    const outcome = await fetchAndParseSitemapSource(domain, source, sitemapRepository, discoveredUrlRepository, {
      fetchImpl,
    });
    expect(outcome.discoveredCount).toBe(2);
  });

  it('detects gzip by magic bytes even without a content-encoding header', async () => {
    const domain = makeDomain();
    const sitemapRepository = createFakeSitemapRepository();
    const discoveredUrlRepository = createFakeDiscoveredUrlRepository();
    const source = makeSource(domain.id, { url: 'https://example.com/sitemap.xml.gz', normalizedUrl: 'https://example.com/sitemap.xml.gz' });
    const gzipped = zlib.gzipSync(Buffer.from(URLSET_XML));

    const fetchImpl = fakeFetch(() => ({ status: 200, body: gzipped, headers: {} }));

    const outcome = await fetchAndParseSitemapSource(domain, source, sitemapRepository, discoveredUrlRepository, {
      fetchImpl,
    });
    expect(outcome.discoveredCount).toBe(2);
  });

  it('rejects URLs from a different domain silently (skips, does not throw)', async () => {
    const domain = makeDomain();
    const sitemapRepository = createFakeSitemapRepository();
    const discoveredUrlRepository = createFakeDiscoveredUrlRepository();
    const source = makeSource(domain.id);
    const mixedXml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/ok</loc></url>
      <url><loc>https://evil.com/bad</loc></url>
    </urlset>`;

    const fetchImpl = fakeFetch(() => ({ status: 200, body: Buffer.from(mixedXml), headers: {} }));
    const outcome = await fetchAndParseSitemapSource(domain, source, sitemapRepository, discoveredUrlRepository, {
      fetchImpl,
    });
    expect(outcome.discoveredCount).toBe(1);
  });

  it('records SITEMAP_FETCH_FAILED and marks the source failed on non-200 status', async () => {
    const domain = makeDomain();
    const sitemapRepository = createFakeSitemapRepository();
    const discoveredUrlRepository = createFakeDiscoveredUrlRepository();
    const source = await sitemapRepository.upsert({
      domainId: domain.id,
      url: 'https://example.com/sitemap.xml',
      normalizedUrl: 'https://example.com/sitemap.xml',
      type: 'sitemap',
    });

    const fetchImpl = fakeFetch(() => ({ status: 500, body: Buffer.from(''), headers: {} }));
    await expect(
      fetchAndParseSitemapSource(domain, source, sitemapRepository, discoveredUrlRepository, { fetchImpl }),
    ).rejects.toMatchObject({ code: 'SITEMAP_FETCH_FAILED' });

    const updated = await sitemapRepository.findById(source.id);
    expect(updated!.status).toBe('failed');
  });

  it('rejects DOCTYPE/XXE payloads via SITEMAP_PARSE_FAILED', async () => {
    const domain = makeDomain();
    const sitemapRepository = createFakeSitemapRepository();
    const discoveredUrlRepository = createFakeDiscoveredUrlRepository();
    const source = await sitemapRepository.upsert({
      domainId: domain.id,
      url: 'https://example.com/sitemap.xml',
      normalizedUrl: 'https://example.com/sitemap.xml',
      type: 'sitemap',
    });
    const xxe = `<!DOCTYPE urlset [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/&xxe;</loc></url></urlset>`;

    const fetchImpl = fakeFetch(() => ({ status: 200, body: Buffer.from(xxe), headers: {} }));
    await expect(
      fetchAndParseSitemapSource(domain, source, sitemapRepository, discoveredUrlRepository, { fetchImpl }),
    ).rejects.toMatchObject({ code: 'SITEMAP_FETCH_FAILED' });
  });
});
