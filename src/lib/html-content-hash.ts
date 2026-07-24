import { createHash, timingSafeEqual } from 'node:crypto';

// contentHash always represents the UNCOMPRESSED HTML, hashed as UTF-8
// bytes — never the compressed/stored representation, and never a raw
// JS string hashed with an ambiguous/implicit encoding. Storage bytes may
// be Brotli or gzip encoded (see src/lib/html-compression.ts); after
// reading an object back and decoding it, re-hashing the result must
// reproduce this same value (see src/services/cache-storage-service.ts's
// readReadyHtml integrity check). Deliberately excludes requestId,
// timestamps, storage headers, API keys, cookies, the URL, and any
// compression metadata — none of those are part of "what HTML was
// rendered".
export function computeHtmlContentHash(html: string): string {
  return createHash('sha256').update(Buffer.from(html, 'utf8')).digest('hex');
}

const HEX64_RE = /^[0-9a-f]{64}$/;

export function isValidContentHash(value: string): boolean {
  return HEX64_RE.test(value);
}

// Constant-time comparison for the read-path integrity check — this is
// not a secret-equality check in the classic sense, but using a
// non-short-circuiting compare avoids leaking any timing signal about how
// much of a stored object's hash an attacker-influenced input matched.
export function contentHashesMatch(a: string, b: string): boolean {
  if (!isValidContentHash(a) || !isValidContentHash(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
