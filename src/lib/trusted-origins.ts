// Parses AUTH_TRUSTED_ORIGINS (comma-separated) into a strict allowlist.
// Used both for Better Auth's own CSRF origin check and for the
// application-level Origin check on cookie-authenticated management
// endpoints (src/lib/csrf.ts).
export function parseTrustedOrigins(raw: string, isProduction: boolean): string[] {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (entries.length === 0) {
    throw new Error('AUTH_TRUSTED_ORIGINS must contain at least one origin');
  }

  const result: string[] = [];
  for (const entry of entries) {
    if (entry === '*') {
      throw new Error('Wildcard origin (*) is not allowed in AUTH_TRUSTED_ORIGINS');
    }

    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error(`Invalid origin in AUTH_TRUSTED_ORIGINS: ${entry}`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Origin must use http/https: ${entry}`);
    }
    if (isProduction && parsed.protocol !== 'https:') {
      throw new Error(`Production requires HTTPS origins: ${entry}`);
    }
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      throw new Error(`Origin must not include a path: ${entry}`);
    }
    if (parsed.search) {
      throw new Error(`Origin must not include a query string: ${entry}`);
    }
    if (parsed.hash) {
      throw new Error(`Origin must not include a fragment: ${entry}`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`Origin must not include credentials: ${entry}`);
    }

    result.push(`${parsed.protocol}//${parsed.host}`);
  }

  return [...new Set(result)];
}
