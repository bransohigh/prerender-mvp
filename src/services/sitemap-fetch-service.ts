import { AppError } from '../lib/app-error.js';
import { safeFetch, SafeFetchError, type SafeFetchResult } from '../lib/safe-http-client.js';
import type { UrlValidator } from '../types/render.js';
import { parseSitemapXml, decompressGzipLimited, SitemapParseError } from '../lib/sitemap-parser.js';
import { normalizeTargetUrl, InvalidTargetUrlError } from '../lib/url-normalize.js';
import { createNoopMetrics, type Metrics } from '../lib/metrics.js';
import type {
  Domain,
  DiscoveredUrlRepository,
  SitemapRepository,
  SitemapSource,
} from '../repositories/types.js';

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
  metrics?: Metrics;
  urlValidator?: UrlValidator;
  // Test injection point — replaces the safeFetch transport entirely.
  // Production always uses the default (real safeFetch, real TLS/proxy).
  fetchImpl?: typeof safeFetch;
}

export interface SitemapFetchOutcome {
  discoveredCount: number;
  errorCode?: string;
}

function looksGzipped(body: Buffer, contentEncoding: string | undefined, url: string): boolean {
  if (contentEncoding?.toLowerCase().includes('gzip')) return true;
  if (url.toLowerCase().endsWith('.gz')) return true;
  return body.length > 2 && body[0] === 0x1f && body[1] === 0x8b;
}

// Fetches and parses a single sitemap_source. Handles gzip, sitemap index
// recursion (bounded depth + nested-sitemap count), and per-domain URL
// total. Every discovered <loc> is re-validated with normalizeTargetUrl
// (HTTPS, same hostname, port 443, no credentials) before being stored —
// a malicious/misconfigured sitemap cannot smuggle in off-domain or
// unsafe-scheme URLs. XML parsing never resolves DTDs/entities (see
// src/lib/sitemap-parser.ts).
export async function fetchAndParseSitemapSource(
  domain: Domain,
  source: SitemapSource,
  sitemapRepository: SitemapRepository,
  discoveredUrlRepository: DiscoveredUrlRepository,
  options?: SitemapFetchOptions,
): Promise<SitemapFetchOutcome> {
  const metrics = options?.metrics ?? createNoopMetrics();
  const startedAt = Date.now();

  try {
    const outcome = await fetchRecursive(
      domain,
      source.normalizedUrl,
      source.id,
      0,
      sitemapRepository,
      discoveredUrlRepository,
      options,
      { nestedCount: 0 },
    );

    await sitemapRepository.recordFetchResult(source.id, {
      status: 'success',
      lastHttpStatus: 200,
      discoveredUrlCount: outcome.discoveredCount,
    });

    metrics.incrementSitemapFetch(source.type, 'success');
    metrics.incrementSitemapUrlsDiscovered(outcome.discoveredCount);
    return outcome;
  } catch (err) {
    const errorCode = errorCodeFor(err);
    await sitemapRepository.recordFetchResult(source.id, {
      status: 'failed',
      lastErrorCode: errorCode,
    });
    metrics.incrementSitemapFetch(source.type, 'failure');
    if (err instanceof AppError) throw err;
    throw new AppError('SITEMAP_FETCH_FAILED', `Sitemap fetch failed: ${errorCode}`);
  } finally {
    metrics.observeSitemapFetchDuration((Date.now() - startedAt) / 1000);
  }
}

function errorCodeFor(err: unknown): string {
  if (err instanceof SafeFetchError) return `fetch_${err.reason}`;
  if (err instanceof SitemapParseError) return `parse_${err.reason}`;
  if (err instanceof AppError) return err.code;
  return 'unknown';
}

async function fetchRecursive(
  domain: Domain,
  url: string,
  sitemapSourceId: string,
  depth: number,
  sitemapRepository: SitemapRepository,
  discoveredUrlRepository: DiscoveredUrlRepository,
  options: SitemapFetchOptions | undefined,
  state: { nestedCount: number },
): Promise<SitemapFetchOutcome> {
  if (depth > SITEMAP_FETCH_LIMITS.maxIndexDepth) {
    throw new AppError('SITEMAP_LIMIT_EXCEEDED', 'Sitemap index recursion depth exceeded');
  }

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
  const parsed = parseSitemapXml(xml, SITEMAP_FETCH_LIMITS.maxUrlsPerSitemap);

  if (parsed.kind === 'sitemapindex') {
    let discoveredCount = 0;
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
      const nestedSource = await sitemapRepository.upsert({
        domainId: domain.id,
        url: entry.loc,
        normalizedUrl: normalized.normalizedUrl,
        type: 'sitemap',
      });

      try {
        const nestedOutcome = await fetchRecursive(
          domain,
          normalized.normalizedUrl,
          nestedSource.id,
          depth + 1,
          sitemapRepository,
          discoveredUrlRepository,
          options,
          state,
        );
        discoveredCount += nestedOutcome.discoveredCount;
        await sitemapRepository.recordFetchResult(nestedSource.id, {
          status: 'success',
          lastHttpStatus: 200,
          discoveredUrlCount: nestedOutcome.discoveredCount,
        });
      } catch (err) {
        await sitemapRepository.recordFetchResult(nestedSource.id, {
          status: 'failed',
          lastErrorCode: errorCodeFor(err),
        });
        // One bad nested sitemap doesn't fail the whole index fetch.
      }
    }
    return { discoveredCount };
  }

  // urlset: validate + upsert page URLs.
  const existingTotal = await discoveredUrlRepository.countByDomain(domain.id);
  const remainingBudget = SITEMAP_FETCH_LIMITS.maxTotalUrlsPerDomain - existingTotal;
  if (remainingBudget <= 0) {
    throw new AppError('SITEMAP_LIMIT_EXCEEDED', 'Per-domain discovered URL limit reached');
  }

  const upsertInputs = [];
  for (const entry of parsed.urls) {
    if (upsertInputs.length >= remainingBudget) break;
    let normalized;
    try {
      normalized = normalizeTargetUrl(entry.loc, domain.normalizedHostname);
    } catch (err) {
      if (err instanceof InvalidTargetUrlError) continue; // skip off-domain/invalid entries
      throw err;
    }
    upsertInputs.push({
      domainId: domain.id,
      sitemapSourceId,
      url: entry.loc,
      normalizedUrl: normalized.normalizedUrl,
      path: normalized.path,
      lastmod: entry.lastmod ?? null,
      priority: entry.priority ?? null,
      changefreq: entry.changefreq ?? null,
    });
  }

  const count = await discoveredUrlRepository.upsertMany(upsertInputs);
  return { discoveredCount: count };
}
