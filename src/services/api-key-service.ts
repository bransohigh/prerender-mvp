import { AppError } from '../lib/app-error.js';
import type { TenantRepository } from '../repositories/postgres/tenant-repository.js';
import type { ApiKeyRepository, ApiKeyRow, ApiKeyMetadata } from '../repositories/postgres/api-key-repository.js';

// Project-scoped render API key MANAGEMENT (create/list/revoke/rotate).
// Key VERIFICATION at render time (Checkpoint 3B) uses
// `auth.api.verifyApiKey` directly from render.ts, which hashes an
// incoming key the same way this service's repository stores it and
// applies Better Auth's own enabled/expiresAt checks — so this service
// intentionally has no dependency on the `Auth` instance at all.
//
// All writes go through src/repositories/postgres/api-key-repository.ts
// (direct Drizzle access to Better Auth's `apikey` table, configured with
// `references: 'organization'` in src/auth/auth.ts) rather than Better
// Auth's own create/get/update/list/delete endpoints — see that file's
// header comment for why (its org-scoped create endpoint runs an
// unconfigured, unrelated organization access-control check that would
// reject admins this app's own permission matrix allows).
//
// Rotation is a single atomic Postgres transaction with the original row
// locked via SELECT ... FOR UPDATE for its duration (see
// api-key-repository.ts's rotateApiKeyForProject) — there is no
// compensating "restore the old key" step anywhere in this file. If the
// transaction fails partway, Postgres rolls back the whole thing and the
// original key is untouched; if it succeeds, exactly one successor key
// exists and the original is atomically revoked in the same commit.
//
// Better Auth's `apikey` table has no native project/createdByUserId/
// revokedAt/rotatedFromKeyId/rotatedToKeyId columns — those live in the
// key's own `metadata` JSON (enabled via `enableMetadata: true`), the
// smallest wrapper that avoids a second key-storage table. Metadata is
// validated on every read (parseAndValidateMetadata in the repository)
// and never trusted as-is.
//
// Known plugin behavior (documented, not a gap introduced here): once a
// key is past its expiresAt AND a verify attempt is made against it, the
// plugin hard-deletes the row (see @better-auth/api-key's
// verify-api-key route). Until the first post-expiry verify call, the row
// still exists with a past expiresAt, so list/get compute `status:
// 'expired'` from `expiresAt` directly rather than a stored enum.

const KEY_PREFIX = 'pr_live_';
const MAX_EXPIRES_IN_DAYS = 365;
const MIN_EXPIRES_IN_DAYS = 1;
const DEFAULT_EXPIRES_IN_DAYS = 90;
const MIN_NAME_LENGTH = 1;
const MAX_NAME_LENGTH = 100;
// Native per-key rate limiting (Better Auth's own rateLimitMax/rateLimitTimeWindow
// fields, enforced inside auth.api.verifyApiKey) — satisfies "valid project
// keys" render-request rate limiting without custom bookkeeping.
const KEY_RATE_LIMIT_MAX = 120;
const KEY_RATE_LIMIT_WINDOW_MS = 60 * 1000;

export interface ApiKeySummary {
  id: string;
  name: string | null;
  prefix: string | null;
  start: string | null;
  status: 'active' | 'revoked' | 'expired';
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

export interface CreateApiKeyResult extends ApiKeySummary {
  key: string;
}

export type RevokeKeyResult = 'revoked' | 'not_found' | 'already_revoked';
export type RotateKeyResult = CreateApiKeyResult | 'not_found' | 'already_revoked' | 'already_rotated' | 'expired';

function computeStatus(enabled: boolean, expiresAt: Date | null): 'active' | 'revoked' | 'expired' {
  if (!enabled) return 'revoked';
  if (expiresAt && expiresAt.getTime() <= Date.now()) return 'expired';
  return 'active';
}

function toSummary(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    start: row.start,
    status: computeStatus(row.enabled, row.expiresAt),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.metadata?.revokedAt ? new Date(row.metadata.revokedAt) : null,
    lastUsedAt: row.lastRequest,
  };
}

export function validateApiKeyName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < MIN_NAME_LENGTH || trimmed.length > MAX_NAME_LENGTH) {
    throw new AppError('INVALID_DOMAIN', `name must be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters`);
  }
  return trimmed;
}

export function createApiKeyService(tenant: TenantRepository, apiKeyRepo: ApiKeyRepository) {
  async function createKey(params: {
    organizationId: string;
    projectId: string;
    name: string;
    expiresInDays?: number;
    createdByUserId: string;
    requestId: string | null;
  }): Promise<CreateApiKeyResult> {
    const project = await tenant.getProjectForOrganization(params.organizationId, params.projectId);
    if (!project) {
      throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
    }

    const name = validateApiKeyName(params.name);
    const expiresInDays = params.expiresInDays ?? DEFAULT_EXPIRES_IN_DAYS;
    if (expiresInDays < MIN_EXPIRES_IN_DAYS || expiresInDays > MAX_EXPIRES_IN_DAYS) {
      throw new AppError('INVALID_DOMAIN', `expiresInDays must be between ${MIN_EXPIRES_IN_DAYS} and ${MAX_EXPIRES_IN_DAYS}`);
    }

    const metadata: ApiKeyMetadata = {
      projectId: params.projectId,
      createdByUserId: params.createdByUserId,
      revokedAt: null,
      rotatedFromKeyId: null,
      rotatedToKeyId: null,
    };

    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const created = await apiKeyRepo.createApiKeyForProject({
      organizationId: params.organizationId,
      name,
      prefix: KEY_PREFIX,
      expiresAt,
      rateLimitMax: KEY_RATE_LIMIT_MAX,
      rateLimitTimeWindowMs: KEY_RATE_LIMIT_WINDOW_MS,
      metadata,
      requestId: params.requestId,
    });

    return { ...toSummary(created), key: created.key };
  }

  async function listKeys(organizationId: string, projectId: string): Promise<ApiKeySummary[]> {
    const project = await tenant.getProjectForOrganization(organizationId, projectId);
    if (!project) {
      throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
    }
    const rows = await apiKeyRepo.listApiKeysForProject(organizationId, projectId);
    return rows.map(toSummary);
  }

  async function revokeKey(
    organizationId: string,
    projectId: string,
    keyId: string,
    actorUserId: string,
    requestId: string | null,
  ): Promise<RevokeKeyResult> {
    const existing = await apiKeyRepo.getApiKeyForProject(organizationId, projectId, keyId);
    if (!existing) return 'not_found';
    if (!existing.enabled) return 'already_revoked';

    const metadata: ApiKeyMetadata = {
      ...(existing.metadata as ApiKeyMetadata),
      projectId,
      revokedAt: new Date().toISOString(),
    };

    await apiKeyRepo.setEnabledAndMetadataForProject(organizationId, projectId, keyId, false, metadata, actorUserId, requestId);
    return 'revoked';
  }

  async function rotateKey(
    organizationId: string,
    projectId: string,
    keyId: string,
    createdByUserId: string,
    requestId: string | null,
  ): Promise<RotateKeyResult> {
    // A pre-check (outside the transaction) only picks reasonable
    // name/expiry defaults for the successor — it is not relied upon for
    // correctness. The actual active/enabled/not-already-rotated decision
    // is made again, atomically, inside rotateApiKeyForProject's locked
    // transaction; this pre-check result can be stale under concurrency
    // and that's fine, because the transaction is the source of truth.
    const existing = await apiKeyRepo.getApiKeyForProject(organizationId, projectId, keyId);
    if (!existing) return 'not_found';

    const expiresInDays = existing.expiresAt
      ? Math.max(MIN_EXPIRES_IN_DAYS, Math.ceil((existing.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
      : DEFAULT_EXPIRES_IN_DAYS;
    const expiresAt = new Date(Date.now() + Math.min(expiresInDays, MAX_EXPIRES_IN_DAYS) * 24 * 60 * 60 * 1000);

    const result = await apiKeyRepo.rotateApiKeyForProject({
      organizationId,
      projectId,
      keyId,
      name: existing.name ?? 'Rotated key',
      prefix: KEY_PREFIX,
      expiresAt,
      rateLimitMax: KEY_RATE_LIMIT_MAX,
      rateLimitTimeWindowMs: KEY_RATE_LIMIT_WINDOW_MS,
      createdByUserId,
      requestId,
    });

    if (result.outcome !== 'rotated') return result.outcome;
    return { ...toSummary(result.key), key: result.key.key };
  }

  return { createKey, listKeys, revokeKey, rotateKey };
}

export type ApiKeyService = ReturnType<typeof createApiKeyService>;
