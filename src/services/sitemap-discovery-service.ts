import { AppError } from '../lib/app-error.js';
import { safeFetch } from '../lib/safe-http-client.js';
import type { UrlValidator } from '../types/render.js';
import { extractSitemapDirectives } from '../lib/robots-parser.js';
import { normalizeTargetUrl, InvalidTargetUrlError } from '../lib/url-normalize.js';
import type { Domain, SitemapSourceType } from '../repositories/types.js';

const MAX_DISCOVERED_SOURCES = 20;
const ROBOTS_MAX_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 2;

export interface SitemapDiscoveryOptions {
  proxyUrl?: string;
  urlValidator?: UrlValidator;
  fetchImpl?: typeof safeFetch;
}

export interface SitemapDiscoveryCandidate {
  url: string;
  normalizedUrl: string;
  type: SitemapSourceType;
}

export interface SitemapDiscoveryScanResult {
  candidates: SitemapDiscoveryCandidate[];
  robotsFound: boolean;
}

// Network-only: fetches robots.txt and derives candidate sitemap source
// URLs (no database access at all). Checkpoint 3C-2 correction: this used
// to upsert each candidate as it was found, interleaving network and
// database work; it's now pure network+validation, and the caller
// persists the result in one transaction — see
// src/repositories/postgres/sitemap-persistence-repository.ts's
// persistSitemapDiscovery(), which does that write plus the
// sitemap.discovery.completed/failed audit event atomically. Callers must
// have already confirmed domain.status === 'verified'.
export async function scanForSitemapCandidates(
  domain: Domain,
  options?: SitemapDiscoveryOptions,
): Promise<SitemapDiscoveryScanResult> {
  const candidateUrls = new Map<string, SitemapSourceType>();
  let robotsFound = false;

  const robotsUrl = `https://${domain.normalizedHostname}/robots.txt`;
  try {
    const fetchFn = options?.fetchImpl ?? safeFetch;
    const result = await fetchFn(robotsUrl, {
      proxyUrl: options?.proxyUrl,
      maxBytes: ROBOTS_MAX_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
      requiredHostname: domain.normalizedHostname,
      urlValidator: options?.urlValidator,
    });
    if (result.status === 200) {
      robotsFound = true;
      const body = result.body.toString('utf8');
      for (const url of extractSitemapDirectives(body, MAX_DISCOVERED_SOURCES)) {
        candidateUrls.set(url, 'sitemap');
      }
    }
  } catch {
    // robots.txt is optional — absence or fetch failure just means we fall
    // back to the conventional default sitemap locations below.
  }

  candidateUrls.set(`https://${domain.normalizedHostname}/sitemap.xml`, 'sitemap');
  candidateUrls.set(`https://${domain.normalizedHostname}/sitemap_index.xml`, 'sitemap_index');

  const candidates: SitemapDiscoveryCandidate[] = [];
  let count = 0;
  for (const [rawUrl, type] of candidateUrls) {
    if (count >= MAX_DISCOVERED_SOURCES) break;

    let normalized;
    try {
      normalized = normalizeTargetUrl(rawUrl, domain.normalizedHostname);
    } catch (err) {
      if (err instanceof InvalidTargetUrlError) continue; // skip invalid/off-domain candidates silently
      throw err;
    }

    candidates.push({ url: rawUrl, normalizedUrl: normalized.normalizedUrl, type });
    count++;
  }

  return { candidates, robotsFound };
}

export function assertDomainVerifiedForSitemap(domain: Domain | null): asserts domain is Domain {
  if (!domain) {
    throw new AppError('DOMAIN_NOT_FOUND', 'Domain not found');
  }
  if (domain.status !== 'verified') {
    throw new AppError('DOMAIN_NOT_VERIFIED', 'Domain must be verified before sitemap discovery');
  }
}
