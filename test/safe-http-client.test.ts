import { describe, expect, it } from 'vitest';
import { assertValidHop, assertRedirectBudget, SafeFetchError } from '../src/lib/safe-http-client.js';

describe('assertValidHop', () => {
  it('accepts an HTTPS URL with no required hostname', () => {
    expect(() => assertValidHop(new URL('https://example.com/'))).not.toThrow();
  });

  it('rejects HTTP (downgrade)', () => {
    expect(() => assertValidHop(new URL('http://example.com/'))).toThrow(SafeFetchError);
    try {
      assertValidHop(new URL('http://example.com/'));
    } catch (err) {
      expect((err as SafeFetchError).reason).toBe('redirect_downgrade');
    }
  });

  it('accepts a matching required hostname', () => {
    expect(() => assertValidHop(new URL('https://example.com/'), 'example.com')).not.toThrow();
  });

  it('rejects a mismatched hostname (cross-host redirect)', () => {
    expect(() => assertValidHop(new URL('https://evil.com/'), 'example.com')).toThrow(SafeFetchError);
    try {
      assertValidHop(new URL('https://evil.com/'), 'example.com');
    } catch (err) {
      expect((err as SafeFetchError).reason).toBe('redirect_host_mismatch');
    }
  });

  it('rejects a subdomain redirect target even though it looks related', () => {
    expect(() => assertValidHop(new URL('https://sub.example.com/'), 'example.com')).toThrow(SafeFetchError);
  });
});

describe('assertRedirectBudget', () => {
  it('allows redirects within budget', () => {
    expect(() => assertRedirectBudget(1, 2)).not.toThrow();
    expect(() => assertRedirectBudget(2, 2)).not.toThrow();
  });

  it('rejects once the budget is exceeded', () => {
    expect(() => assertRedirectBudget(3, 2)).toThrow(SafeFetchError);
    try {
      assertRedirectBudget(3, 2);
    } catch (err) {
      expect((err as SafeFetchError).reason).toBe('too_many_redirects');
    }
  });
});
