import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFakeSitemapRepository } from '../src/repositories/fake/fake-sitemap-repository.js';
import { discoverSitemapSources, assertDomainVerifiedForSitemap } from '../src/services/sitemap-discovery-service.js';
import type { SafeFetchResult, safeFetch } from '../src/lib/safe-http-client.js';
import type { Domain } from '../src/repositories/types.js';

function makeDomain(overrides: Partial<Domain> = {}): Domain {
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
    ...overrides,
  };
}

function fakeFetch(handler: (url: string) => SafeFetchResult): typeof safeFetch {
  return (async (url: string) => handler(url)) as typeof safeFetch;
}

describe('assertDomainVerifiedForSitemap', () => {
  it('throws DOMAIN_NOT_FOUND for null', () => {
    expect(() => assertDomainVerifiedForSitemap(null)).toThrow();
  });

  it('throws DOMAIN_NOT_VERIFIED for a pending domain', () => {
    expect(() => assertDomainVerifiedForSitemap(makeDomain({ status: 'pending' }))).toThrow();
  });

  it('passes for a verified domain', () => {
    expect(() => assertDomainVerifiedForSitemap(makeDomain({ status: 'verified' }))).not.toThrow();
  });
});

describe('discoverSitemapSources', () => {
  it('discovers sitemaps listed in robots.txt', async () => {
    const domain = makeDomain();
    const repo = createFakeSitemapRepository();
    const fetchImpl = fakeFetch((url) => {
      if (url.endsWith('/robots.txt')) {
        return {
          status: 200,
          body: Buffer.from('Sitemap: https://example.com/custom-sitemap.xml'),
          headers: {},
        };
      }
      return { status: 404, body: Buffer.from(''), headers: {} };
    });

    const result = await discoverSitemapSources(domain, repo, { fetchImpl });
    expect(result.robotsFound).toBe(true);
    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain('https://example.com/custom-sitemap.xml');
    expect(urls).toContain('https://example.com/sitemap.xml');
    expect(urls).toContain('https://example.com/sitemap_index.xml');
  });

  it('falls back to default locations when robots.txt is missing', async () => {
    const domain = makeDomain();
    const repo = createFakeSitemapRepository();
    const fetchImpl = fakeFetch(() => ({ status: 404, body: Buffer.from(''), headers: {} }));

    const result = await discoverSitemapSources(domain, repo, { fetchImpl });
    expect(result.robotsFound).toBe(false);
    expect(result.sources).toHaveLength(2);
  });

  it('rejects an off-domain sitemap URL from robots.txt silently (does not throw)', async () => {
    const domain = makeDomain();
    const repo = createFakeSitemapRepository();
    const fetchImpl = fakeFetch((url) => {
      if (url.endsWith('/robots.txt')) {
        return {
          status: 200,
          body: Buffer.from('Sitemap: https://evil.com/sitemap.xml'),
          headers: {},
        };
      }
      return { status: 404, body: Buffer.from(''), headers: {} };
    });

    const result = await discoverSitemapSources(domain, repo, { fetchImpl });
    expect(result.sources.map((s) => s.url)).not.toContain('https://evil.com/sitemap.xml');
  });

  it('deduplicates repeated sitemap URLs across robots.txt and defaults', async () => {
    const domain = makeDomain();
    const repo = createFakeSitemapRepository();
    const fetchImpl = fakeFetch((url) => {
      if (url.endsWith('/robots.txt')) {
        return {
          status: 200,
          body: Buffer.from('Sitemap: https://example.com/sitemap.xml'),
          headers: {},
        };
      }
      return { status: 404, body: Buffer.from(''), headers: {} };
    });

    const result = await discoverSitemapSources(domain, repo, { fetchImpl });
    const sitemapXmlCount = result.sources.filter((s) => s.url === 'https://example.com/sitemap.xml').length;
    expect(sitemapXmlCount).toBe(1);
  });
});
