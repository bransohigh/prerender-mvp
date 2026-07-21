import { AppError, type AppErrorCode } from '../lib/app-error.js';
import { validateApiKeyMetadataObject } from '../repositories/postgres/api-key-repository.js';
import type { Auth } from '../auth/auth.js';

// Structural (not nominal) dependency on Better Auth: only the one method
// this service actually calls. The real `Auth` instance satisfies this
// automatically (TypeScript structural typing); unit tests inject a small
// literal object instead of constructing a real Better Auth instance.
export interface ApiKeyVerifier {
  api: {
    verifyApiKey: Auth['api']['verifyApiKey'];
  };
}

// Render-only API key authentication. Never used by (or exposed to)
// management routes — those go through
// src/repositories/postgres/api-key-repository.ts directly.
//
// Better Auth's auth.api.verifyApiKey is the source of truth for the
// SECRET itself (hash lookup, timing-safe comparison, enabled/expiresAt
// checks, and its own request-count based rate limiting — see the header
// comment in api-key-repository.ts and test/db/api-key-hash-compat.test.ts
// for the hashing contract). It does NOT validate metadata shape at all —
// confirmed by reading @better-auth/api-key@1.6.23's validateApiKey
// implementation, which only ever reads `apiKey.enabled`/`apiKey.expiresAt`
// and returns whatever is in the `metadata` column untouched. So a row
// with syntactically-valid-JSON-but-wrong-shape metadata (e.g. a
// non-UUID projectId, or a stray revokedAt) would still verify as
// `valid: true` from Better Auth's point of view — this service is what
// independently re-validates metadata shape, and re-checks
// revokedAt/rotatedToKeyId as defense in depth even though `enabled`
// already reflects that state today.

export interface TrustedRenderKeyScope {
  apiKeyId: string;
  organizationId: string;
  projectId: string;
  createdByUserId: string;
  expiresAt: Date | null;
}

function mapVerifyErrorCode(code: string | undefined): AppErrorCode {
  switch (code) {
    case 'KEY_EXPIRED':
      return 'API_KEY_EXPIRED';
    case 'KEY_DISABLED':
      return 'API_KEY_REVOKED';
    case 'RATE_LIMIT_EXCEEDED':
    case 'USAGE_EXCEEDED':
      return 'RATE_LIMITED';
    default:
      return 'API_KEY_INVALID';
  }
}

// Verifies a raw render API key and returns only the minimum trusted scope
// needed for authorization — never the plaintext key, stored hash, raw
// metadata, or Better Auth's internal response object.
export async function verifyRenderApiKey(auth: ApiKeyVerifier, rawKey: string): Promise<TrustedRenderKeyScope> {
  const result = await auth.api.verifyApiKey({ body: { key: rawKey } });

  if (!result.valid || !result.key) {
    throw new AppError(mapVerifyErrorCode(result.error?.code), 'Invalid API key');
  }

  const metadata = validateApiKeyMetadataObject(result.key.metadata);
  if (!metadata) {
    throw new AppError('API_KEY_METADATA_INVALID', 'Invalid API key');
  }

  // Defense in depth: `enabled` (checked by Better Auth above) already
  // reflects revoke/rotate state today, but if that ever drifted from the
  // metadata mirror, fail closed rather than trust either signal alone.
  if (metadata.revokedAt || metadata.rotatedToKeyId) {
    throw new AppError('API_KEY_REVOKED', 'Invalid API key');
  }

  return {
    apiKeyId: result.key.id,
    organizationId: result.key.referenceId,
    projectId: metadata.projectId,
    createdByUserId: metadata.createdByUserId,
    expiresAt: result.key.expiresAt,
  };
}
