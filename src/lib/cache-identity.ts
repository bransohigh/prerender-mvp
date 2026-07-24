import { createHash } from 'node:crypto';
import { normalizeTargetUrl, InvalidTargetUrlError } from './url-normalize.js';

// Bump this whenever the cache key FORMULA itself changes (which fields
// are included, their order, the separator, the hash algorithm) — never
// when only render-affecting behavior changes (that's
// RENDER_PROFILE_VERSION in src/lib/render-profile.ts). Bumping this
// value deliberately invalidates every existing cache identity at once,
// since old rows carry the old cache_key_version and will never match a
// lookup built with the new one.
export const CACHE_KEY_VERSION = 1;

export interface CacheIdentity {
  organizationId: string;
  projectId: string;
  domainId: string;
  // Must already be the renderer's own validated+normalized URL (see
  // normalizeUrlForCache below) — this module does not re-validate it.
  normalizedUrl: string;
  // Hex SHA-256 from src/lib/render-profile.ts's computeRenderProfileHash().
  renderProfileHash: string;
  cacheKeyVersion?: number;
}

export interface CacheKey {
  cacheKeyVersion: number;
  cacheKeyHash: string;
  normalizedUrlHash: string;
}

// NUL (charCode 0) is not a valid character in a URL, an organization/
// project/domain id, or a hex hash — so it can never appear inside any
// field being joined here, making it an unambiguous separator. A
// printable delimiter (e.g. "|" or ":") could in principle appear inside
// a URL's query string, which would let two DIFFERENT (identity, url)
// pairs collide on the same joined string before hashing.
const FIELD_SEPARATOR = String.fromCharCode(0);

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function computeNormalizedUrlHash(normalizedUrl: string): string {
  return sha256Hex(normalizedUrl);
}

// sha256(cacheKeyVersion + orgId + projectId + domainId + normalizedUrl +
// renderProfileHash), NUL-separated (see FIELD_SEPARATOR) rather than
// built by ambiguous string concatenation — swapping which field holds
// which value can never produce the same joined string for two distinct
// identities, since every field is NUL-delimited on both sides.
export function computeCacheKey(identity: CacheIdentity): CacheKey {
  const cacheKeyVersion = identity.cacheKeyVersion ?? CACHE_KEY_VERSION;
  const joined = [
    String(cacheKeyVersion),
    identity.organizationId,
    identity.projectId,
    identity.domainId,
    identity.normalizedUrl,
    identity.renderProfileHash,
  ].join(FIELD_SEPARATOR);
  return {
    cacheKeyVersion,
    cacheKeyHash: sha256Hex(joined),
    normalizedUrlHash: computeNormalizedUrlHash(identity.normalizedUrl),
  };
}

// Reuses the renderer's own validated URL policy (src/lib/url-normalize.ts
// — HTTPS-only, port 443 only, no credentials, exact-hostname match, query
// string preserved verbatim, fragment dropped) rather than a second URL
// parser/normalizer that could disagree with it. WHATWG URL parsing
// (used inside normalizeTargetUrl) already: lowercases the scheme and
// hostname, converts Unicode/IDN hostnames to their ASCII punycode form
// before normalizeHostname() lowercases that too, resolves "." and ".."
// path segments, and does not re-decode percent-encoded characters (its
// own single-pass encoding is trusted as-is — no manual double-decode
// anywhere in this codebase).
export { normalizeTargetUrl as normalizeUrlForCache, InvalidTargetUrlError };
export type { NormalizedTargetUrl } from './url-normalize.js';
