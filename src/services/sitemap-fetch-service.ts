import { AppError } from '../lib/app-error.js';
import { safeFetch, SafeFetchError, type SafeFetchResult } from '../lib/safe-http-client.js';
import type { UrlValidator } from '../types/render.js';
import { parseSitemapXml, decompressGzipLimited, SitemapParseError } from '../lib/sitemap-parser.js';
import { normalizeTargetUrl, InvalidTargetUrlError } from '../lib/url-normalize.js';
import type { Domain } from '../repositories/types.js';

export const SITEMAP_FETCH_LIMITS = {
  maxResponseBytes: 20 * 1024 * 1024, // 20 MB compressed/raw response cap
  maxDecompressedBytes: 50 * 1024 * 1024, // decompression-bomb guard
  maxUrlsPerSitemap: 50_000, // matches the sitemaps.org protocol limit
  maxTotalUrlsPerDomain: 200_000,
  maxIndexDepth: 3,
  maxNestedSitemapsPerIndex: 500,
  fetchTimeoutMs: 15_000,
  maxRedirects: 2,
} as const;

export interface SitemapFetchOptions {
  proxyUrl?: string;
  urlValidator?: UrlValidator;
  // Test injection point — replaces the safeFetch transport entirely.
  // Production always uses the default (real safeFetch, real TLS/proxy).
  fetchImpl?: typeof safeFetch;
}

export interface ParsedSitemapUrl {
  url: string;
  normalizedUrl: string;
  path: string;
  lastmod: string | null;
  priority: string | null;
  changefreq: string | null;
}

export type SitemapNodeOutcome =
  | { status: 'success'; urls: ParsedSitemapUrl[] }
  | { status: 'failed'; errorCode: string };

// A pure network+parse result tree — no database access anywhere in its
// construction (Checkpoint 3C-2 correction). One node per sitemap
// document actually fetched; `children` holds nested <sitemap> entries
// found inside a sitemapindex document. The caller persists this whole
// tree in a single transaction — see
// src/repositories/postgres/sitemap-persistence-repository.ts's
// persistSitemapFetch().
export interface SitemapFetchNode {
  url: string;
  normalizedUrl: string;
  outcome: SitemapNodeOutcome;
  children: SitemapFetchNode[];
}

function looksGzipped(body: Buffer, contentEncoding: string | undefined, url: string): boolean {
  if (contentEncoding?.toLowerCase().includes('gzip')) return true;
  if (url.toLowerCase().endsWith('.gz')) return true;
  return body.length > 2 && body[0] === 0x1f && body[1] === 0x8b;
}

export function errorCodeFor(err: unknown): string {
  if (err instanceof SafeFetchError) return `fetch_${err.reason}`;
  if (err instanceof SitemapParseError) return `parse_${err.reason}`;
  if (err instanceof AppError) return err.code;
  return 'unknown';
}

interface RawParsedDocument {
  kind: 'sitemapindex' | 'urlset';
  urls: Array<{ loc: string; lastmod?: string; priority?: string; changefreq?: string }>;
}

async function fetchAndParseOne(domain: Domain, url: string, options: SitemapFetchOptions | undefined): Promise<RawParsedDocument> {
  const fetchFn = options?.fetchImpl ?? safeFetch;
  const result: SafeFetchResult = await fetchFn(url, {
    proxyUrl: options?.proxyUrl,
    maxBytes: SITEMAP_FETCH_LIMITS.maxResponseBytes,
    timeoutMs: SITEMAP_FETCH_LIMITS.fetchTimeoutMs,
    maxRedirects: SITEMAP_FETCH_LIMITS.maxRedirects,
    requiredHostname: domain.normalizedHostname,
    urlValidator: options?.urlValidator,
  });

  if (result.status !== 200) {
    throw new AppError('SITEMAP_FETCH_FAILED', `Unexpected HTTP status ${result.status}`);
  }

  const contentEncoding = Array.isArray(result.headers['content-encoding'])
    ? result.headers['content-encoding'][0]
    : result.headers['content-encoding'];

  let raw = result.body;
  if (looksGzipped(raw, contentEncoding, url)) {
    raw = await decompressGzipLimited(raw, SITEMAP_FETCH_LIMITS.maxDecompressedBytes);
  }

  const xml = raw.toString('utf8');
  return parseSitemapXml(xml, SITEMAP_FETCH_LIMITS.maxUrlsPerSitemap);
}

interface RecursionState {
  nestedCount: number;
  remainingUrlBudget: number;
}

// Recursively fetches+parses a sitemap document tree with no database
// access. depth===0 is the originally requested source — a failure there
// propagates to the caller (top-level fetch failure). A failure fetching
// a NESTED (depth>0) sitemap-index entry is caught and recorded as a
// 'failed' outcome for just that node — matching the pre-3C-2 behavior
// that "one bad nested sitemap doesn't fail the whole index fetch".
export async function buildSitemapFetchTree(
  domain: Domain,
  url: string,
  depth: number,
  state: RecursionState,
  options?: SitemapFetchOptions,
): Promise<SitemapFetchNode> {
  if (depth > SITEMAP_FETCH_LIMITS.maxIndexDepth) {
    throw new AppError('SITEMAP_LIMIT_EXCEEDED', 'Sitemap index recursion depth exceeded');
  }

  let parsed: RawParsedDocument;
  try {
    parsed = await fetchAndParseOne(domain, url, options);
  } catch (err) {
    // Only the top-level (originally requested) node normalizes its own
    // error to AppError('SITEMAP_FETCH_FAILED', ...) here — a nested
    // entry's raw error is caught by the sitemapindex loop below (via
    // errorCodeFor) and recorded as a 'failed' child node instead of
    // propagating, so this branch only ever fires for depth===0.
    if (depth === 0) {
      if (err instanceof AppError) throw err;
      throw new AppError('SITEMAP_FETCH_FAILED', `Sitemap fetch failed: ${errorCodeFor(err)}`);
    }
    throw err;
  }

  if (parsed.kind === 'sitemapindex') {
    const children: SitemapFetchNode[] = [];
    for (const entry of parsed.urls) {
      if (state.nestedCount >= SITEMAP_FETCH_LIMITS.maxNestedSitemapsPerIndex) break;

      let normalized;
      try {
        normalized = normalizeTargetUrl(entry.loc, domain.normalizedHostname);
      } catch (err) {
        if (err instanceof InvalidTargetUrlError) continue;
        throw err;
      }

      state.nestedCount++;
      try {
        const child = await buildSitemapFetchTree(domain, normalized.normalizedUrl, depth + 1, state, options);
        children.push(child);
      } catch (err) {
        children.push({
          url: entry.loc,
          normalizedUrl: normalized.normalizedUrl,
          outcome: { status: 'failed', errorCode: errorCodeFor(err) },
          children: [],
        });
      }
    }
    return { url, normalizedUrl: url, outcome: { status: 'success', urls: [] }, children };
  }

  // urlset: validate + collect page URLs (bounded by the shared per-domain
  // budget, decremented across the whole recursive operation rather than
  // re-read from the database per node — closes a TOCTOU gap the old
  // per-node countByDomain() re-check had).
  if (state.remainingUrlBudget <= 0) {
    throw new AppError('SITEMAP_LIMIT_EXCEEDED', 'Per-domain discovered URL limit reached');
  }

  const urls: ParsedSitemapUrl[] = [];
  for (const entry of parsed.urls) {
    if (state.remainingUrlBudget <= 0) break;
    let normalized;
    try {
      normalized = normalizeTargetUrl(entry.loc, domain.normalizedHostname);
    } catch (err) {
      if (err instanceof InvalidTargetUrlError) continue; // skip off-domain/invalid entries
      throw err;
    }
    urls.push({
      url: entry.loc,
      normalizedUrl: normalized.normalizedUrl,
      path: normalized.path,
      lastmod: entry.lastmod ?? null,
      priority: entry.priority ?? null,
      changefreq: entry.changefreq ?? null,
    });
    state.remainingUrlBudget--;
  }

  return { url, normalizedUrl: url, outcome: { status: 'success', urls }, children: [] };
}

// Total discovered URL count across the whole tree (top node + every
// successful descendant) — matches what the old single-pass
// fetchAndParseSitemapSource returned as `discoveredCount`.
export function countDiscoveredUrls(node: SitemapFetchNode): number {
  const own = node.outcome.status === 'success' ? node.outcome.urls.length : 0;
  return node.children.reduce((sum, child) => sum + countDiscoveredUrls(child), own);
}
