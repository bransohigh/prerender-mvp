import { AppError } from '../lib/app-error.js';
import { safeFetch } from '../lib/safe-http-client.js';
import type { UrlValidator } from '../types/render.js';
import { extractSitemapDirectives } from '../lib/robots-parser.js';
import { normalizeTargetUrl, InvalidTargetUrlError } from '../lib/url-normalize.js';
import type { Domain, SitemapRepository, SitemapSource, SitemapSourceType } from '../repositories/types.js';

const MAX_DISCOVERED_SOURCES = 20;
const ROBOTS_MAX_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 2;

export interface SitemapDiscoveryOptions {
  proxyUrl?: string;
  urlValidator?: UrlValidator;
  fetchImpl?: typeof safeFetch;
}

export interface SitemapDiscoveryResult {
  sources: SitemapSource[];
  robotsFound: boolean;
}

// Discovers sitemap source URLs for a verified domain: robots.txt Sitemap:
// directives, plus the two conventional default locations. Only records
// sources — actual sitemap XML fetch/parse happens separately via
// POST /v1/sitemap-sources/:sourceId/fetch. Callers must have already
// confirmed domain.status === 'verified'.
export async function discoverSitemapSources(
  domain: Domain,
  sitemapRepository: SitemapRepository,
  options?: SitemapDiscoveryOptions,
): Promise<SitemapDiscoveryResult> {
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

  const sources: SitemapSource[] = [];
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

    const source = await sitemapRepository.upsert({
      domainId: domain.id,
      url: rawUrl,
      normalizedUrl: normalized.normalizedUrl,
      type,
    });
    sources.push(source);
    count++;
  }

  return { sources, robotsFound };
}

export function assertDomainVerifiedForSitemap(domain: Domain | null): asserts domain is Domain {
  if (!domain) {
    throw new AppError('DOMAIN_NOT_FOUND', 'Domain not found');
  }
  if (domain.status !== 'verified') {
    throw new AppError('DOMAIN_NOT_VERIFIED', 'Domain must be verified before sitemap discovery');
  }
}
