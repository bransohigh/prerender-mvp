import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CACHE_OBJECT_LIMITS,
  InvalidCacheObjectLimitsError,
  MAX_DECOMPRESSED_READ_BYTES_CEILING,
  MAX_STORED_OBJECT_BYTES_CEILING,
  MAX_UNCOMPRESSED_HTML_BYTES_CEILING,
  validateCacheObjectLimits,
} from '../src/lib/cache-object-limits.js';

describe('validateCacheObjectLimits', () => {
  it('accepts the documented defaults', () => {
    expect(validateCacheObjectLimits(DEFAULT_CACHE_OBJECT_LIMITS)).toEqual(DEFAULT_CACHE_OBJECT_LIMITS);
  });

  it('accepts values at the ceiling', () => {
    expect(() =>
      validateCacheObjectLimits({
        maxUncompressedHtmlBytes: MAX_UNCOMPRESSED_HTML_BYTES_CEILING,
        maxStoredObjectBytes: MAX_STORED_OBJECT_BYTES_CEILING,
        maxDecompressedReadBytes: MAX_DECOMPRESSED_READ_BYTES_CEILING,
      }),
    ).not.toThrow();
  });

  it('rejects a value above the ceiling', () => {
    expect(() =>
      validateCacheObjectLimits({ ...DEFAULT_CACHE_OBJECT_LIMITS, maxUncompressedHtmlBytes: MAX_UNCOMPRESSED_HTML_BYTES_CEILING + 1 }),
    ).toThrow(InvalidCacheObjectLimitsError);
  });

  it('rejects zero', () => {
    expect(() => validateCacheObjectLimits({ ...DEFAULT_CACHE_OBJECT_LIMITS, maxStoredObjectBytes: 0 })).toThrow(
      InvalidCacheObjectLimitsError,
    );
  });

  it('rejects a negative value', () => {
    expect(() => validateCacheObjectLimits({ ...DEFAULT_CACHE_OBJECT_LIMITS, maxDecompressedReadBytes: -1 })).toThrow(
      InvalidCacheObjectLimitsError,
    );
  });

  it('rejects a non-integer value', () => {
    expect(() => validateCacheObjectLimits({ ...DEFAULT_CACHE_OBJECT_LIMITS, maxUncompressedHtmlBytes: 100.5 })).toThrow(
      InvalidCacheObjectLimitsError,
    );
  });

  it('rejects NaN/Infinity', () => {
    expect(() => validateCacheObjectLimits({ ...DEFAULT_CACHE_OBJECT_LIMITS, maxStoredObjectBytes: Number.NaN })).toThrow(
      InvalidCacheObjectLimitsError,
    );
    expect(() =>
      validateCacheObjectLimits({ ...DEFAULT_CACHE_OBJECT_LIMITS, maxDecompressedReadBytes: Number.POSITIVE_INFINITY }),
    ).toThrow(InvalidCacheObjectLimitsError);
  });
});
