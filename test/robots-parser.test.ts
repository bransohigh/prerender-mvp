import { describe, expect, it } from 'vitest';
import { extractSitemapDirectives } from '../src/lib/robots-parser.js';

describe('extractSitemapDirectives', () => {
  it('extracts a single Sitemap directive', () => {
    const body = 'User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml';
    expect(extractSitemapDirectives(body)).toEqual(['https://example.com/sitemap.xml']);
  });

  it('is case-insensitive', () => {
    const body = 'sitemap: https://example.com/sitemap.xml';
    expect(extractSitemapDirectives(body)).toEqual(['https://example.com/sitemap.xml']);
  });

  it('handles multiple Sitemap directives', () => {
    const body = 'Sitemap: https://example.com/a.xml\nSitemap: https://example.com/b.xml';
    expect(extractSitemapDirectives(body)).toEqual([
      'https://example.com/a.xml',
      'https://example.com/b.xml',
    ]);
  });

  it('strips comments', () => {
    const body = '# this is a comment\nSitemap: https://example.com/sitemap.xml # trailing comment';
    expect(extractSitemapDirectives(body)).toEqual(['https://example.com/sitemap.xml']);
  });

  it('normalizes surrounding whitespace', () => {
    const body = 'Sitemap:    https://example.com/sitemap.xml   ';
    expect(extractSitemapDirectives(body)).toEqual(['https://example.com/sitemap.xml']);
  });

  it('ignores non-Sitemap directives', () => {
    const body = 'User-agent: *\nDisallow: /\nAllow: /public\nCrawl-delay: 5';
    expect(extractSitemapDirectives(body)).toEqual([]);
  });

  it('ignores blank lines', () => {
    const body = '\n\nSitemap: https://example.com/sitemap.xml\n\n';
    expect(extractSitemapDirectives(body)).toEqual(['https://example.com/sitemap.xml']);
  });

  it('respects the maxEntries cap', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Sitemap: https://example.com/${i}.xml`).join('\n');
    expect(extractSitemapDirectives(lines, 5)).toHaveLength(5);
  });

  it('handles CRLF line endings', () => {
    const body = 'Sitemap: https://example.com/sitemap.xml\r\nUser-agent: *';
    expect(extractSitemapDirectives(body)).toEqual(['https://example.com/sitemap.xml']);
  });
});
