import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  createBrotliDecompress,
  createGunzip,
  gunzipSync,
  gzipSync,
} from 'node:zlib';
import type { CacheContentEncoding } from './cache-storage-key.js';

export class UnsupportedEncodingError extends Error {}
export class DecompressedSizeLimitExceededError extends Error {}
export class CorruptCompressedDataError extends Error {}

// Fixed, deterministic compression settings — never derived from request
// input. Brotli is the preferred default (better ratio for HTML/text);
// gzip is kept for compatibility; identity is for tests/debugging only
// (see CACHE_ARCHITECTURE.md).
const BROTLI_OPTIONS = {
  params: {
    [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
    [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
  },
};
const GZIP_OPTIONS = { level: 6 };

export function compressHtml(html: string, encoding: CacheContentEncoding): Buffer {
  const input = Buffer.from(html, 'utf8');
  switch (encoding) {
    case 'br':
      return brotliCompressSync(input, BROTLI_OPTIONS);
    case 'gzip':
      return gzipSync(input, GZIP_OPTIONS);
    case 'identity':
      return input;
    default:
      throw new UnsupportedEncodingError(`unsupported content encoding: ${String(encoding)}`);
  }
}

// Synchronous decompression is only safe when the caller has ALREADY
// bounded the compressed input size (see maxStoredObjectBytes in
// src/lib/cache-object-limits.ts) — brotliDecompressSync/gunzipSync both
// support a maxOutputLength option, which is the real defense against a
// decompression bomb (a small compressed input expanding to an enormous
// output). Corrupt input surfaces as a thrown Error from zlib, which is
// re-wrapped below into a typed, safe (no internal buffer contents)
// error.
export function decompressHtml(data: Buffer, encoding: CacheContentEncoding, maxDecompressedBytes: number): string {
  try {
    switch (encoding) {
      case 'br': {
        const out = brotliDecompressSync(data, { maxOutputLength: maxDecompressedBytes });
        return out.toString('utf8');
      }
      case 'gzip': {
        const out = gunzipSync(data, { maxOutputLength: maxDecompressedBytes });
        return out.toString('utf8');
      }
      case 'identity':
        if (data.byteLength > maxDecompressedBytes) {
          throw new DecompressedSizeLimitExceededError('identity-encoded object exceeds the configured decompressed size limit');
        }
        return data.toString('utf8');
      default:
        throw new UnsupportedEncodingError(`unsupported content encoding: ${String(encoding)}`);
    }
  } catch (err) {
    if (err instanceof DecompressedSizeLimitExceededError || err instanceof UnsupportedEncodingError) {
      throw err;
    }
    // node:zlib throws ERR_BUFFER_TOO_LARGE-shaped errors when
    // maxOutputLength is exceeded, and a generic Error for malformed
    // compressed data — neither error's message is trusted verbatim
    // (it can echo back internal buffer state), so it is normalized to
    // one of our two typed errors instead.
    const code = (err as { code?: string } | undefined)?.code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new DecompressedSizeLimitExceededError('decompressed output would exceed the configured size limit');
    }
    throw new CorruptCompressedDataError('stored object could not be decompressed (corrupt or truncated data)');
  }
}

// Exported separately so the module can be exercised with real streaming
// decompression semantics in tests without relying on maxOutputLength's
// synchronous behavior alone — kept for future streaming-store adapters.
export function createDecompressStream(encoding: Exclude<CacheContentEncoding, 'identity'>) {
  return encoding === 'br' ? createBrotliDecompress() : createGunzip();
}
