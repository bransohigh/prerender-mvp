import { describe, expect, it } from 'vitest';
import {
  generateVerificationToken,
  hashVerificationToken,
  verifyTokenAgainstHash,
  dnsTxtRecordName,
  dnsTxtRecordValue,
  htmlVerificationFileContent,
} from '../src/lib/verification-token.js';

describe('generateVerificationToken', () => {
  it('produces a 256-bit (64 hex char) token', () => {
    const token = generateVerificationToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces different tokens each call', () => {
    const a = generateVerificationToken();
    const b = generateVerificationToken();
    expect(a).not.toBe(b);
  });
});

describe('hashVerificationToken / verifyTokenAgainstHash', () => {
  it('hash is deterministic for the same token', () => {
    const token = generateVerificationToken();
    expect(hashVerificationToken(token)).toBe(hashVerificationToken(token));
  });

  it('hash is a sha256 hex digest (64 chars)', () => {
    const token = generateVerificationToken();
    expect(hashVerificationToken(token)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('verifyTokenAgainstHash succeeds for the matching token', () => {
    const token = generateVerificationToken();
    const hash = hashVerificationToken(token);
    expect(verifyTokenAgainstHash(token, hash)).toBe(true);
  });

  it('verifyTokenAgainstHash fails for a different token', () => {
    const hash = hashVerificationToken(generateVerificationToken());
    expect(verifyTokenAgainstHash(generateVerificationToken(), hash)).toBe(false);
  });

  it('verifyTokenAgainstHash never throws on length mismatch', () => {
    expect(() => verifyTokenAgainstHash('short', 'alsoshort')).not.toThrow();
    expect(verifyTokenAgainstHash('short', 'alsoshort')).toBe(false);
  });

  it('the plaintext token is never derivable from the hash alone in this module', () => {
    // Sanity check that hash !== token (i.e. we are not accidentally storing plaintext).
    const token = generateVerificationToken();
    expect(hashVerificationToken(token)).not.toBe(token);
  });
});

describe('DNS TXT record name/value', () => {
  it('record name uses the _prerender-verification prefix', () => {
    expect(dnsTxtRecordName('example.com')).toBe('_prerender-verification.example.com');
  });

  it('record value embeds the token with a stable prefix', () => {
    const token = 'abc123';
    expect(dnsTxtRecordValue(token)).toBe('prerender-verification=abc123');
  });
});

describe('HTML verification file content', () => {
  it('embeds the token with the same stable prefix as DNS', () => {
    const token = 'abc123';
    expect(htmlVerificationFileContent(token)).toBe('prerender-verification=abc123\n');
  });
});
