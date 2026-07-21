import { normalizeHostname } from './url-security.js';

export type InvalidUrlReason =
  | 'invalid_url'
  | 'not_https'
  | 'credentials'
  | 'non_standard_port'
  | 'host_mismatch'
  | 'too_long';

export class InvalidTargetUrlError extends Error {
  readonly reason: InvalidUrlReason;
  constructor(reason: InvalidUrlReason, message: string) {
    super(message);
    this.name = 'InvalidTargetUrlError';
    this.reason = reason;
  }
}

const MAX_URL_LENGTH = 2048;
const MAX_PATH_LENGTH = 1024;
const MAX_QUERY_LENGTH = 1024;

export interface NormalizedTargetUrl {
  normalizedUrl: string;
  hostname: string;
  path: string;
}

// Normalizes a target URL (sitemap entry or render request URL) and
// enforces the fixed policy for this system: HTTPS only, port 443 only,
// no credentials, must match the given required hostname exactly (no
// automatic subdomain inclusion). Query strings are preserved verbatim
// (parameter order untouched, tracking params not stripped in this MVP).
// Dot-segments are normalized by the URL parser itself (per WHATWG URL).
// Percent-encoding is NOT re-decoded — the URL parser's own single-pass
// encoding is trusted as-is (no manual double-decode).
export function normalizeTargetUrl(
  rawUrl: string,
  requiredHostname: string,
): NormalizedTargetUrl {
  if (rawUrl.length > MAX_URL_LENGTH) {
    throw new InvalidTargetUrlError('too_long', `URL ${MAX_URL_LENGTH} karakteri aşamaz`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidTargetUrlError('invalid_url', 'Geçersiz URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new InvalidTargetUrlError('not_https', 'Yalnızca HTTPS URL kabul edilir');
  }

  if (parsed.username || parsed.password) {
    throw new InvalidTargetUrlError('credentials', 'Kimlik bilgisi içeren URL kabul edilmez');
  }

  if (parsed.port !== '' && parsed.port !== '443') {
    throw new InvalidTargetUrlError('non_standard_port', 'Yalnızca 443 portuna izin verilir');
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (hostname !== requiredHostname) {
    throw new InvalidTargetUrlError('host_mismatch', 'URL hostname doğrulanmış domain ile eşleşmiyor');
  }

  if (parsed.pathname.length > MAX_PATH_LENGTH) {
    throw new InvalidTargetUrlError('too_long', `Path ${MAX_PATH_LENGTH} karakteri aşamaz`);
  }
  if (parsed.search.length > MAX_QUERY_LENGTH) {
    throw new InvalidTargetUrlError('too_long', `Query string ${MAX_QUERY_LENGTH} karakteri aşamaz`);
  }

  // Fragment is never part of an HTTP request — drop it. Default port and
  // dot-segments are already normalized by the URL parser (parsed.port is
  // '' for default 443; parsed.pathname resolves . and .. segments).
  const normalized = `https://${hostname}${parsed.pathname}${parsed.search}`;

  return { normalizedUrl: normalized, hostname, path: parsed.pathname };
}
