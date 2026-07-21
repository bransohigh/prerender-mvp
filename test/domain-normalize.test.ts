import { describe, expect, it } from 'vitest';
import { normalizeAndValidateHostname, InvalidHostnameError } from '../src/lib/domain-normalize.js';

describe('normalizeAndValidateHostname', () => {
  it('lowercases the hostname', () => {
    expect(normalizeAndValidateHostname('WWW.Example.COM')).toBe('www.example.com');
  });

  it('removes trailing dot', () => {
    expect(normalizeAndValidateHostname('example.com.')).toBe('example.com');
  });

  it('normalizes IDNA/punycode Unicode domains deterministically', () => {
    const result = normalizeAndValidateHostname('münchen.example');
    expect(result).toMatch(/^xn--/);
    // Same result every time for the same input.
    expect(normalizeAndValidateHostname('münchen.example')).toBe(result);
  });

  it('rejects scheme', () => {
    expect(() => normalizeAndValidateHostname('https://example.com')).toThrow(InvalidHostnameError);
  });

  it('rejects path', () => {
    expect(() => normalizeAndValidateHostname('example.com/path')).toThrow(InvalidHostnameError);
  });

  it('rejects credentials', () => {
    expect(() => normalizeAndValidateHostname('user@example.com')).toThrow(InvalidHostnameError);
  });

  it('rejects port', () => {
    expect(() => normalizeAndValidateHostname('example.com:8080')).toThrow(InvalidHostnameError);
  });

  it('rejects wildcard', () => {
    expect(() => normalizeAndValidateHostname('*.example.com')).toThrow(InvalidHostnameError);
  });

  it.each(['127.0.0.1', '10.0.0.1', '::1', '2001:db8::1'])('rejects IP address: %s', (ip) => {
    expect(() => normalizeAndValidateHostname(ip)).toThrow(InvalidHostnameError);
  });

  it('rejects localhost', () => {
    expect(() => normalizeAndValidateHostname('localhost')).toThrow(InvalidHostnameError);
  });

  it('rejects .local suffix', () => {
    expect(() => normalizeAndValidateHostname('printer.local')).toThrow(InvalidHostnameError);
  });

  it('rejects metadata hostnames', () => {
    expect(() => normalizeAndValidateHostname('metadata.google.internal')).toThrow(InvalidHostnameError);
  });

  it('rejects single-label (docker service-like) names', () => {
    expect(() => normalizeAndValidateHostname('renderer-api')).toThrow(InvalidHostnameError);
    expect(() => normalizeAndValidateHostname('egress-proxy')).toThrow(InvalidHostnameError);
  });

  it('rejects empty string', () => {
    expect(() => normalizeAndValidateHostname('')).toThrow(InvalidHostnameError);
  });

  it('accepts a normal public hostname', () => {
    expect(normalizeAndValidateHostname('www.example.com')).toBe('www.example.com');
  });

  it('accepts apex domain', () => {
    expect(normalizeAndValidateHostname('example.com')).toBe('example.com');
  });
});
