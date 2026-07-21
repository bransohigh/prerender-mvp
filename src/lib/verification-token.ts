import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// 256-bit (32 byte) cryptographically secure random token, hex-encoded (64 chars).
export function generateVerificationToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashVerificationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// Constant-time comparison against the stored hash. Never compares
// plaintext tokens directly against each other — always hash-vs-hash.
export function verifyTokenAgainstHash(token: string, storedHash: string): boolean {
  const candidateHash = hashVerificationToken(token);
  const a = Buffer.from(candidateHash, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function dnsTxtRecordName(normalizedHostname: string): string {
  return `_prerender-verification.${normalizedHostname}`;
}

export function dnsTxtRecordValue(token: string): string {
  return `prerender-verification=${token}`;
}

export function htmlVerificationFileContent(token: string): string {
  return `prerender-verification=${token}\n`;
}

export const HTML_VERIFICATION_PATH = '/.well-known/prerender-verification.txt';
