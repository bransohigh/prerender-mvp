import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeHtmlContentHash, contentHashesMatch, isValidContentHash } from '../src/lib/html-content-hash.js';

describe('computeHtmlContentHash', () => {
  it('is deterministic for identical input', () => {
    expect(computeHtmlContentHash('<html></html>')).toBe(computeHtmlContentHash('<html></html>'));
  });

  it('produces a 64-char lowercase hex digest', () => {
    expect(computeHtmlContentHash('<html></html>')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is sensitive to multibyte UTF-8 content (hashes bytes, not code points)', () => {
    const ascii = computeHtmlContentHash('<p>cafe</p>');
    const multibyte = computeHtmlContentHash('<p>café</p>');
    expect(ascii).not.toBe(multibyte);
  });

  it('hashes the explicit UTF-8 byte encoding, matching Buffer.from(html, "utf8")', () => {
    const html = '<p>日本語のページ</p>';
    expect(computeHtmlContentHash(html)).toBe(createHash('sha256').update(Buffer.from(html, 'utf8')).digest('hex'));
  });

  it('differs for different content', () => {
    expect(computeHtmlContentHash('<a></a>')).not.toBe(computeHtmlContentHash('<b></b>'));
  });
});

describe('isValidContentHash', () => {
  it('accepts a 64-char lowercase hex string', () => {
    expect(isValidContentHash('a'.repeat(64))).toBe(true);
  });

  it('rejects uppercase hex', () => {
    expect(isValidContentHash('A'.repeat(64))).toBe(false);
  });

  it('rejects the wrong length', () => {
    expect(isValidContentHash('a'.repeat(63))).toBe(false);
    expect(isValidContentHash('a'.repeat(65))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidContentHash('z'.repeat(64))).toBe(false);
  });
});

describe('contentHashesMatch', () => {
  it('returns true for identical valid hashes', () => {
    const h = computeHtmlContentHash('<html></html>');
    expect(contentHashesMatch(h, h)).toBe(true);
  });

  it('returns false for different valid hashes', () => {
    expect(contentHashesMatch('a'.repeat(64), 'b'.repeat(64))).toBe(false);
  });

  it('returns false (not throws) for malformed input', () => {
    expect(contentHashesMatch('not-a-hash', 'a'.repeat(64))).toBe(false);
  });
});
