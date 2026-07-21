import { createHmac } from 'node:crypto';

// Derives safe rate-limiter map keys from secret material — never used to
// verify anything, only to partition limiter buckets without the raw
// secret (API key, email, invitation token) ever becoming a map key or
// appearing in a log line. HMAC-SHA256 keyed with BETTER_AUTH_SECRET so
// the digest isn't independently guessable/reversible by an attacker who
// doesn't have the server secret.

export function hmacDigest(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

export function normalizedEmailDigest(secret: string, email: string): string {
  return hmacDigest(secret, email.trim().toLowerCase());
}

export function invitationTokenDigest(secret: string, token: string): string {
  return hmacDigest(secret, token);
}
