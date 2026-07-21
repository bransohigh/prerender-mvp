import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseSitemapXml, decompressGzipLimited, SitemapParseError } from '../src/lib/sitemap-parser.js';

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
    <lastmod>2024-01-01</lastmod>
    <priority>0.8</priority>
    <changefreq>daily</changefreq>
  </url>
  <url>
    <loc>https://example.com/page2</loc>
  </url>
</urlset>`;

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap-1.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap-2.xml</loc>
  </sitemap>
</sitemapindex>`;

const XXE_PAYLOAD = `<?xml version="1.0"?>
<!DOCTYPE urlset [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/&xxe;</loc></url>
</urlset>`;

describe('parseSitemapXml', () => {
  it('parses a urlset with loc/lastmod/priority/changefreq', () => {
    const result = parseSitemapXml(URLSET, 1000);
    expect(result.kind).toBe('urlset');
    expect(result.urls).toHaveLength(2);
    expect(result.urls[0]).toEqual({
      loc: 'https://example.com/page1',
      lastmod: '2024-01-01',
      priority: '0.8',
      changefreq: 'daily',
    });
    expect(result.urls[1]).toEqual({ loc: 'https://example.com/page2' });
  });

  it('parses a sitemapindex', () => {
    const result = parseSitemapXml(SITEMAP_INDEX, 1000);
    expect(result.kind).toBe('sitemapindex');
    expect(result.urls.map((u) => u.loc)).toEqual([
      'https://example.com/sitemap-1.xml',
      'https://example.com/sitemap-2.xml',
    ]);
  });

  it('rejects DOCTYPE declarations (XXE defense)', () => {
    expect(() => parseSitemapXml(XXE_PAYLOAD, 1000)).toThrow(SitemapParseError);
    try {
      parseSitemapXml(XXE_PAYLOAD, 1000);
    } catch (err) {
      expect(err).toBeInstanceOf(SitemapParseError);
      expect((err as SitemapParseError).reason).toBe('dtd_rejected');
    }
  });

  it('never resolves an external entity into output', () => {
    // Even if DOCTYPE weren't rejected, sax has no entity-expansion code
    // path — verify no /etc/passwd content leaks into parsed output.
    let result;
    try {
      result = parseSitemapXml(XXE_PAYLOAD, 1000);
    } catch {
      result = null;
    }
    if (result) {
      expect(JSON.stringify(result)).not.toContain('root:');
    }
  });

  it('rejects unknown root elements', () => {
    expect(() => parseSitemapXml('<foo></foo>', 1000)).toThrow(SitemapParseError);
  });

  it('rejects malformed XML', () => {
    expect(() => parseSitemapXml('<urlset><url><loc>unterminated', 1000)).toThrow(SitemapParseError);
  });

  it('truncates at maxUrls without throwing', () => {
    const many = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from(
      { length: 10 },
      (_, i) => `<url><loc>https://example.com/${i}</loc></url>`,
    ).join('')}</urlset>`;
    const result = parseSitemapXml(many, 5);
    expect(result.urls).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('skips url entries with no loc', () => {
    const body = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><lastmod>2024-01-01</lastmod></url></urlset>`;
    const result = parseSitemapXml(body, 1000);
    expect(result.urls).toHaveLength(0);
  });
});

describe('decompressGzipLimited', () => {
  it('decompresses a valid gzip buffer', async () => {
    const original = Buffer.from('hello world');
    const compressed = zlib.gzipSync(original);
    const result = await decompressGzipLimited(compressed, 1024);
    expect(result.toString('utf8')).toBe('hello world');
  });

  it('rejects when decompressed output exceeds the byte cap (compression bomb guard)', async () => {
    const original = Buffer.alloc(1024 * 1024, 'a'); // 1 MB of repeated bytes compresses tiny
    const compressed = zlib.gzipSync(original);
    await expect(decompressGzipLimited(compressed, 1000)).rejects.toThrow(SitemapParseError);
  });

  it('rejects invalid gzip data', async () => {
    await expect(decompressGzipLimited(Buffer.from('not gzip'), 1024)).rejects.toThrow(SitemapParseError);
  });
});
