import { AppError } from '../lib/app-error.js';
import type { TxtResolver } from '../lib/dns-verification.js';
import { safeFetch, SafeFetchError } from '../lib/safe-http-client.js';
import type { UrlValidator } from '../types/render.js';
import { verifyTokenAgainstHash, HTML_VERIFICATION_PATH } from '../lib/verification-token.js';
import { createNoopMetrics, type Metrics } from '../lib/metrics.js';
import type { Domain, DomainRepository } from '../repositories/types.js';

export type VerificationOutcome =
  | { success: true }
  | { success: false; errorCode: string };

export interface VerifyDomainOptions {
  proxyUrl?: string;
  dnsResolver?: TxtResolver;
  htmlTimeoutMs?: number;
  dnsTimeoutMs?: number;
  urlValidator?: UrlValidator;
  fetchImpl?: typeof safeFetch;
}

const HTML_MAX_BYTES = 8 * 1024; // verification files are a single short line
const HTML_MAX_REDIRECTS = 2;

const TOKEN_LINE_PATTERN = /prerender-verification=([a-f0-9]{64})/i;

function extractTokenFromBody(body: string): string | null {
  const match = TOKEN_LINE_PATTERN.exec(body);
  return match ? match[1]! : null;
}

// Performs the actual verification check for a domain (DNS TXT or HTML
// file). Never persists the plaintext token — the candidate value found in
// DNS/HTTP is hashed and compared against the stored hash via a
// timing-safe comparison. Never logs the token or DNS/HTTP response body.
export async function performDomainVerification(
  domain: Domain,
  options?: VerifyDomainOptions,
): Promise<VerificationOutcome> {
  if (domain.verificationMethod === 'dns_txt') {
    return verifyDnsTxtAgainstHash(domain, options);
  }
  return verifyHtmlFileAgainstHash(domain, options);
}

async function verifyDnsTxtAgainstHash(
  domain: Domain,
  options?: VerifyDomainOptions,
): Promise<VerificationOutcome> {
  const dns = await import('node:dns/promises');
  const resolver: TxtResolver = options?.dnsResolver ?? ((h) => dns.resolveTxt(h));
  const recordName = `_prerender-verification.${domain.normalizedHostname}`;
  const timeoutMs = options?.dnsTimeoutMs ?? 5000;

  let records: string[][];
  try {
    records = await Promise.race([
      resolver(recordName),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), timeoutMs),
      ),
    ]);
  } catch (err) {
    const code =
      err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return { success: false, errorCode: 'dns_nxdomain' };
    if (code === 'ETIMEOUT' || code === 'EAI_AGAIN') return { success: false, errorCode: 'dns_timeout' };
    if (code === 'ESERVFAIL') return { success: false, errorCode: 'dns_servfail' };
    return { success: false, errorCode: 'dns_error' };
  }

  const joined = records.map((segments) => segments.join(''));
  for (const value of joined) {
    const candidate = extractTokenFromBody(value);
    if (candidate && verifyTokenAgainstHash(candidate, domain.verificationTokenHash)) {
      return { success: true };
    }
  }
  return { success: false, errorCode: 'dns_not_found' };
}

async function verifyHtmlFileAgainstHash(
  domain: Domain,
  options?: VerifyDomainOptions,
): Promise<VerificationOutcome> {
  const url = `https://${domain.normalizedHostname}${HTML_VERIFICATION_PATH}`;

  let result;
  try {
    const fetchFn = options?.fetchImpl ?? safeFetch;
    result = await fetchFn(url, {
      proxyUrl: options?.proxyUrl,
      maxBytes: HTML_MAX_BYTES,
      timeoutMs: options?.htmlTimeoutMs ?? 5000,
      maxRedirects: HTML_MAX_REDIRECTS,
      requiredHostname: domain.normalizedHostname,
      urlValidator: options?.urlValidator,
    });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      return { success: false, errorCode: `html_${err.reason}` };
    }
    return { success: false, errorCode: 'html_error' };
  }

  if (result.status !== 200) {
    return { success: false, errorCode: 'html_unexpected_status' };
  }

  const contentType = Array.isArray(result.headers['content-type'])
    ? result.headers['content-type'][0]
    : result.headers['content-type'];
  if (contentType && !contentType.toLowerCase().includes('text/plain')) {
    return { success: false, errorCode: 'html_unexpected_content_type' };
  }

  const body = result.body.toString('utf8');
  const candidate = extractTokenFromBody(body);
  if (candidate && verifyTokenAgainstHash(candidate, domain.verificationTokenHash)) {
    return { success: true };
  }
  return { success: false, errorCode: 'html_token_mismatch' };
}

export interface VerificationRateLimiter {
  tryAcquire: (domainId: string) => boolean;
}

// Process-in-memory rate limiter: max N verification attempts per domain
// per rolling window, plus single-flight deduplication so concurrent
// verify calls for the same domain don't fan out into parallel DNS/HTTP
// requests (also prevents outbound-abuse via request flooding).
export function createVerificationRateLimiter(
  maxPerWindow = 3,
  windowMs = 60_000,
): VerificationRateLimiter {
  const attempts = new Map<string, number[]>();

  return {
    tryAcquire(domainId: string): boolean {
      const now = Date.now();
      const existing = (attempts.get(domainId) ?? []).filter((t) => now - t < windowMs);
      if (existing.length >= maxPerWindow) {
        attempts.set(domainId, existing);
        return false;
      }
      existing.push(now);
      attempts.set(domainId, existing);
      return true;
    },
  };
}

export interface InFlightGuard {
  acquire: (key: string) => boolean;
  release: (key: string) => void;
}

export function createInFlightGuard(): InFlightGuard {
  const inFlight = new Set<string>();
  return {
    acquire(key: string): boolean {
      if (inFlight.has(key)) return false;
      inFlight.add(key);
      return true;
    },
    release(key: string): void {
      inFlight.delete(key);
    },
  };
}

export async function verifyDomainOrThrow(
  domain: Domain,
  domainRepository: DomainRepository,
  rateLimiter: VerificationRateLimiter,
  inFlightGuard: InFlightGuard,
  options: VerifyDomainOptions,
  metrics: Metrics = createNoopMetrics(),
): Promise<Domain> {
  if (!rateLimiter.tryAcquire(domain.id)) {
    throw new AppError('DOMAIN_VERIFICATION_RATE_LIMITED', 'Too many verification attempts, try again shortly');
  }
  if (!inFlightGuard.acquire(domain.id)) {
    throw new AppError('DOMAIN_VERIFICATION_IN_PROGRESS', 'A verification attempt is already in progress for this domain');
  }

  try {
    const outcome = await performDomainVerification(domain, options);
    const updated = await domainRepository.markVerificationAttempt(
      domain.id,
      outcome.success ? { success: true } : { success: false, failureCode: outcome.errorCode },
    );
    if (!updated) {
      throw new AppError('DOMAIN_NOT_FOUND', 'Domain not found');
    }

    metrics.incrementDomainVerification(domain.verificationMethod, outcome.success ? 'success' : 'failure');

    if (!outcome.success) {
      throw new AppError('DOMAIN_VERIFICATION_FAILED', `Verification failed: ${outcome.errorCode}`);
    }
    return updated;
  } finally {
    inFlightGuard.release(domain.id);
  }
}
