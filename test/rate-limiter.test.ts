import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/lib/rate-limiter.js';
import { hmacDigest, normalizedEmailDigest, invitationTokenDigest } from '../src/lib/rate-limit-keys.js';

describe('createRateLimiter', () => {
  it('allows attempts up to maxAttempts, then rejects', () => {
    const now = 0;
    const limiter = createRateLimiter({ windowMs: 1000, maxAttempts: 3, now: () => now });
    try {
      expect(limiter.check('k').allowed).toBe(true);
      expect(limiter.check('k').allowed).toBe(true);
      expect(limiter.check('k').allowed).toBe(true);
      const fourth = limiter.check('k');
      expect(fourth.allowed).toBe(false);
      expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
    } finally {
      limiter.shutdown();
    }
  });

  it('expires the window and allows again (sliding/fixed window reset)', () => {
    let now = 0;
    const limiter = createRateLimiter({ windowMs: 1000, maxAttempts: 1, now: () => now });
    try {
      expect(limiter.check('k').allowed).toBe(true);
      expect(limiter.check('k').allowed).toBe(false);
      now = 1001;
      expect(limiter.check('k').allowed).toBe(true);
    } finally {
      limiter.shutdown();
    }
  });

  it('computes a deterministic Retry-After based on remaining window time', () => {
    let now = 0;
    const limiter = createRateLimiter({ windowMs: 10_000, maxAttempts: 1, now: () => now });
    try {
      limiter.check('k');
      now = 3000; // 7s left in the window
      const decision = limiter.check('k');
      expect(decision.allowed).toBe(false);
      expect(decision.retryAfterSeconds).toBe(7);
    } finally {
      limiter.shutdown();
    }
  });

  it('reset() clears a key so a later success does not inherit a prior failure count', () => {
    const now = 0;
    const limiter = createRateLimiter({ windowMs: 1000, maxAttempts: 1, now: () => now });
    try {
      limiter.check('k');
      expect(limiter.check('k').allowed).toBe(false);
      limiter.reset('k');
      expect(limiter.check('k').allowed).toBe(true);
    } finally {
      limiter.shutdown();
    }
  });

  it('cleanup() drops expired buckets, bounding memory', () => {
    let now = 0;
    const limiter = createRateLimiter({ windowMs: 1000, maxAttempts: 5, now: () => now });
    try {
      limiter.check('a');
      limiter.check('b');
      expect(limiter.size()).toBe(2);
      now = 2000;
      limiter.cleanup();
      expect(limiter.size()).toBe(0);
    } finally {
      limiter.shutdown();
    }
  });

  it('never produces a negative remaining count', () => {
    const now = 0;
    const limiter = createRateLimiter({ windowMs: 1000, maxAttempts: 2, now: () => now });
    try {
      limiter.check('k');
      limiter.check('k');
      const third = limiter.check('k');
      const fourth = limiter.check('k');
      expect(third.remaining).toBeGreaterThanOrEqual(0);
      expect(fourth.remaining).toBeGreaterThanOrEqual(0);
    } finally {
      limiter.shutdown();
    }
  });

  it('shutdown() stops the periodic cleanup timer without throwing', () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxAttempts: 5 });
    expect(() => limiter.shutdown()).not.toThrow();
  });

  it('different keys have independent buckets', () => {
    const now = 0;
    const limiter = createRateLimiter({ windowMs: 1000, maxAttempts: 1, now: () => now });
    try {
      expect(limiter.check('a').allowed).toBe(true);
      expect(limiter.check('b').allowed).toBe(true);
      expect(limiter.check('a').allowed).toBe(false);
    } finally {
      limiter.shutdown();
    }
  });
});

describe('rate-limit-keys (safe digests)', () => {
  it('hmacDigest never returns the raw input value', () => {
    const digest = hmacDigest('server-secret-value', 'super-secret-plaintext-key');
    expect(digest).not.toBe('super-secret-plaintext-key');
    expect(digest).not.toContain('super-secret-plaintext-key');
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('normalizedEmailDigest is case/whitespace-insensitive and never contains the email', () => {
    const a = normalizedEmailDigest('secret', 'User@Example.com');
    const b = normalizedEmailDigest('secret', '  user@example.com  ');
    expect(a).toBe(b);
    expect(a).not.toContain('user@example.com');
    expect(a).not.toContain('User@Example.com');
  });

  it('invitationTokenDigest never returns or contains the raw token', () => {
    const token = 'a'.repeat(64);
    const digest = invitationTokenDigest('secret', token);
    expect(digest).not.toBe(token);
    expect(digest).not.toContain(token);
  });

  it('different secrets produce different digests for the same value (keyed, not guessable without the secret)', () => {
    const d1 = hmacDigest('secret-one', 'same-value');
    const d2 = hmacDigest('secret-two', 'same-value');
    expect(d1).not.toBe(d2);
  });
});
