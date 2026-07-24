import { brotliCompressSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  compressHtml,
  CorruptCompressedDataError,
  decompressHtml,
  DecompressedSizeLimitExceededError,
  UnsupportedEncodingError,
} from '../src/lib/html-compression.js';

const HTML = '<html><body>' + 'hello world '.repeat(200) + '</body></html>';
const MULTIBYTE_HTML = '<html><body>' + '日本語のテスト '.repeat(200) + '</body></html>';

describe('compressHtml / decompressHtml round-trip', () => {
  it('round-trips with brotli', () => {
    const compressed = compressHtml(HTML, 'br');
    expect(decompressHtml(compressed, 'br', 10_000_000)).toBe(HTML);
  });

  it('round-trips with gzip', () => {
    const compressed = compressHtml(HTML, 'gzip');
    expect(decompressHtml(compressed, 'gzip', 10_000_000)).toBe(HTML);
  });

  it('round-trips with identity (no compression)', () => {
    const compressed = compressHtml(HTML, 'identity');
    expect(compressed.toString('utf8')).toBe(HTML);
    expect(decompressHtml(compressed, 'identity', 10_000_000)).toBe(HTML);
  });

  it('brotli produces a smaller payload than identity for repetitive HTML', () => {
    const compressed = compressHtml(HTML, 'br');
    expect(compressed.byteLength).toBeLessThan(Buffer.byteLength(HTML, 'utf8'));
  });

  it('round-trips multibyte UTF-8 content without corruption, for every encoding', () => {
    for (const encoding of ['br', 'gzip', 'identity'] as const) {
      const compressed = compressHtml(MULTIBYTE_HTML, encoding);
      expect(decompressHtml(compressed, encoding, 10_000_000)).toBe(MULTIBYTE_HTML);
    }
  });
});

describe('decompressHtml bounds and error handling', () => {
  it('rejects identity data exceeding the decompressed size limit', () => {
    const compressed = compressHtml(HTML, 'identity');
    expect(() => decompressHtml(compressed, 'identity', 10)).toThrow(DecompressedSizeLimitExceededError);
  });

  it('rejects brotli output exceeding the decompressed size limit (decompression-bomb guard)', () => {
    const bomb = Buffer.from('a'.repeat(1_000_000), 'utf8');
    const compressed = brotliCompressSync(bomb);
    // Compressed form is tiny relative to the 1,000,000-byte output —
    // exactly the shape of a decompression bomb.
    expect(compressed.byteLength).toBeLessThan(10_000);
    expect(() => decompressHtml(compressed, 'br', 1000)).toThrow(DecompressedSizeLimitExceededError);
  });

  it('rejects gzip output exceeding the decompressed size limit (decompression-bomb guard)', () => {
    const bomb = Buffer.from('a'.repeat(1_000_000), 'utf8');
    const compressed = gzipSync(bomb);
    expect(() => decompressHtml(compressed, 'gzip', 1000)).toThrow(DecompressedSizeLimitExceededError);
  });

  it('rejects corrupt brotli data with a typed error, not a raw zlib error', () => {
    const corrupt = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
    expect(() => decompressHtml(corrupt, 'br', 10_000_000)).toThrow(CorruptCompressedDataError);
  });

  it('rejects corrupt gzip data with a typed error, not a raw zlib error', () => {
    const corrupt = Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02, 0x03]);
    expect(() => decompressHtml(corrupt, 'gzip', 10_000_000)).toThrow(CorruptCompressedDataError);
  });

  it('rejects an unsupported encoding value', () => {
    expect(() => decompressHtml(Buffer.from('x'), 'unsupported' as never, 10_000_000)).toThrow(UnsupportedEncodingError);
  });

  it('the typed error never leaks the raw compressed bytes in its message', () => {
    const corrupt = Buffer.from('SENTINEL_SECRET_BYTES_1234567890');
    try {
      decompressHtml(corrupt, 'br', 10_000_000);
      expect.fail('expected decompressHtml to throw');
    } catch (err) {
      expect(String(err)).not.toContain('SENTINEL_SECRET_BYTES');
    }
  });
});
