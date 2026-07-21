import { describe, expect, it } from 'vitest';
import { normalizeTargetUrl, InvalidTargetUrlError } from '../src/lib/url-normalize.js';

describe('normalizeTargetUrl', () => {
  it('accepts a matching HTTPS URL on default port', () => {
    const result = normalizeTargetUrl('https://example.com/page', 'example.com');
    expect(result.normalizedUrl).toBe('https://example.com/page');
    expect(result.hostname).toBe('example.com');
    expect(result.path).toBe('/page');
  });

  it('rejects HTTP (no silent upgrade)', () => {
    expect(() => normalizeTargetUrl('http://example.com/', 'example.com')).toThrow(InvalidTargetUrlError);
  });

  it('lowercases the host', () => {
    const result = normalizeTargetUrl('https://EXAMPLE.com/', 'example.com');
    expect(result.hostname).toBe('example.com');
  });

  it('removes default port 443 explicitly given', () => {
    const result = normalizeTargetUrl('https://example.com:443/page', 'example.com');
    expect(result.normalizedUrl).toBe('https://example.com/page');
  });

  it('rejects non-standard ports', () => {
    expect(() => normalizeTargetUrl('https://example.com:8443/', 'example.com')).toThrow(InvalidTargetUrlError);
  });

  it('removes trailing fragment', () => {
    const result = normalizeTargetUrl('https://example.com/page#section', 'example.com');
    expect(result.normalizedUrl).not.toContain('#');
  });

  it('empty path becomes /', () => {
    const result = normalizeTargetUrl('https://example.com', 'example.com');
    expect(result.path).toBe('/');
  });

  it('normalizes dot-segments via WHATWG URL parsing', () => {
    const result = normalizeTargetUrl('https://example.com/a/../b', 'example.com');
    expect(result.path).toBe('/b');
  });

  it('rejects credentials', () => {
    expect(() => normalizeTargetUrl('https://user:pass@example.com/', 'example.com')).toThrow(
      InvalidTargetUrlError,
    );
  });

  it('rejects a different hostname (no automatic subdomain inclusion)', () => {
    expect(() => normalizeTargetUrl('https://sub.example.com/', 'example.com')).toThrow(InvalidTargetUrlError);
  });

  it('preserves query string parameter order verbatim', () => {
    const result = normalizeTargetUrl('https://example.com/?b=2&a=1', 'example.com');
    expect(result.normalizedUrl).toBe('https://example.com/?b=2&a=1');
  });

  it('does not strip tracking-looking query parameters', () => {
    const result = normalizeTargetUrl('https://example.com/?utm_source=x', 'example.com');
    expect(result.normalizedUrl).toContain('utm_source=x');
  });

  it('does not double-decode percent-encoding', () => {
    const result = normalizeTargetUrl('https://example.com/a%2520b', 'example.com');
    expect(result.path).toBe('/a%2520b');
  });

  it('rejects invalid URLs', () => {
    expect(() => normalizeTargetUrl('not a url', 'example.com')).toThrow(InvalidTargetUrlError);
  });

  it('rejects overly long URLs', () => {
    const longPath = '/' + 'a'.repeat(3000);
    expect(() => normalizeTargetUrl(`https://example.com${longPath}`, 'example.com')).toThrow(
      InvalidTargetUrlError,
    );
  });

  it('rejects javascript: scheme', () => {
    expect(() => normalizeTargetUrl('javascript:alert(1)', 'example.com')).toThrow(InvalidTargetUrlError);
  });

  it('rejects data: scheme', () => {
    expect(() => normalizeTargetUrl('data:text/html,hi', 'example.com')).toThrow(InvalidTargetUrlError);
  });

  it('rejects file: scheme', () => {
    expect(() => normalizeTargetUrl('file:///etc/passwd', 'example.com')).toThrow(InvalidTargetUrlError);
  });
});
