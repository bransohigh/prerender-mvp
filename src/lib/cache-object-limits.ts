// Centralized, validated byte limits for the HTML cache object pipeline
// (Phase 8A-2). Every bound here is enforced BEFORE the corresponding
// buffer is fully allocated/read — see src/lib/html-compression.ts for
// the streaming decompression limit and src/services/cache-storage-service.ts
// for where each limit is applied.

export interface CacheObjectLimits {
  // Uncompressed HTML byte length, checked before compression.
  maxUncompressedHtmlBytes: number;
  // Compressed/stored object byte length, checked after compression and
  // again before writing to the object store.
  maxStoredObjectBytes: number;
  // Ceiling on bytes produced while decompressing a stored object on
  // read — guards against a decompression-bomb-style stored object
  // expanding to an unbounded size.
  maxDecompressedReadBytes: number;
}

export const MIN_UNCOMPRESSED_HTML_BYTES = 1;
export const MAX_UNCOMPRESSED_HTML_BYTES_CEILING = 50_000_000; // 50 MB
export const MIN_STORED_OBJECT_BYTES = 1;
export const MAX_STORED_OBJECT_BYTES_CEILING = 50_000_000; // 50 MB
export const MIN_DECOMPRESSED_READ_BYTES = 1;
export const MAX_DECOMPRESSED_READ_BYTES_CEILING = 50_000_000; // 50 MB

// Conservative defaults: an uncompressed HTML page beyond ~10MB is
// already far outside normal rendered-page territory (matches the
// existing render-time MAX_HTML_BYTES conservative posture in
// src/config/env.ts), and the decompressed-read ceiling mirrors the
// uncompressed limit since decompression should never legitimately
// produce more bytes than were originally hashed.
export const DEFAULT_CACHE_OBJECT_LIMITS: CacheObjectLimits = {
  maxUncompressedHtmlBytes: 10_000_000,
  maxStoredObjectBytes: 10_000_000,
  maxDecompressedReadBytes: 10_000_000,
};

export class InvalidCacheObjectLimitsError extends Error {}

function assertBoundedInteger(value: number, label: string, min: number, max: number): void {
  if (!Number.isInteger(value) || !Number.isFinite(value) || value < min || value > max) {
    throw new InvalidCacheObjectLimitsError(`${label} must be an integer between ${min} and ${max} (got ${value})`);
  }
}

export function validateCacheObjectLimits(limits: CacheObjectLimits): CacheObjectLimits {
  assertBoundedInteger(limits.maxUncompressedHtmlBytes, 'maxUncompressedHtmlBytes', MIN_UNCOMPRESSED_HTML_BYTES, MAX_UNCOMPRESSED_HTML_BYTES_CEILING);
  assertBoundedInteger(limits.maxStoredObjectBytes, 'maxStoredObjectBytes', MIN_STORED_OBJECT_BYTES, MAX_STORED_OBJECT_BYTES_CEILING);
  assertBoundedInteger(limits.maxDecompressedReadBytes, 'maxDecompressedReadBytes', MIN_DECOMPRESSED_READ_BYTES, MAX_DECOMPRESSED_READ_BYTES_CEILING);
  return limits;
}
