import { randomBytes, randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { defaultKeyHasher as betterAuthDefaultKeyHasher } from '@better-auth/api-key';
import { apikey } from '../../db/schema.js';
import type { Database } from '../../db/client.js';

// Direct, organization+project-scoped access to Better Auth's `apikey`
// table (configured with `references: 'organization'` in src/auth/auth.ts,
// so `referenceId` holds the organizationId).
//
// Key creation/rotation write this table directly rather than calling
// `auth.api.createApiKey`: that endpoint's `references: 'organization'`
// path unconditionally runs the plugin's own `checkOrgApiKeyPermission`
// (Better Auth organization access-control statements for an `apiKey`
// resource), which isn't configured in this app's `organization()` plugin
// setup and would reject admins that this app's own permission matrix
// (src/auth/permissions.ts) explicitly allows to create keys. Since the
// route already performs the authoritative owner/admin check via
// requireOrganizationPermission before this repository is ever called,
// duplicating (and fighting) the plugin's separate authorization layer
// would be redundant at best and wrong at worst. Key MATERIAL and
// STORAGE still follow Better Auth's own scheme exactly: 256+ bits of
// `crypto.randomBytes`, hashed via hashApiKeySecret() — the single local
// wrapper around the plugin's exported `defaultKeyHasher` (SHA-256 +
// base64url), the same hash function `auth.api.verifyApiKey` uses to look
// up and validate a presented key at render time (Checkpoint 3B), so
// verification is unaffected by bypassing the create endpoint. If a
// future Better Auth upgrade changes or removes this export,
// hashApiKeySecret is the one place to fix, and
// test/db/api-key-hash-compat.test.ts is the compatibility test that must
// be re-run against the new version before upgrading.
//
// get/list/revoke/rotate go directly through Drizzle, scoped in SQL,
// rather than Better Auth's get/update/list/delete endpoints (which
// likewise require a live browser session in their own middleware and
// aren't meant to be called server-side with just an organizationId).
//
// projectId itself is not a native `apikey` column — it lives inside the
// `metadata` JSON text column, so every project-scoped query here also
// parses+validates+filters on that JSON. Metadata is never trusted as-is:
// parseAndValidateMetadata() fails closed (returns null) on anything
// malformed, and every lookup treats a null-metadata row as not found for
// that project — it is never listed, rotated, or revoked through the
// wrong project scope.

const KEY_SECRET_BYTES = 32; // 256 bits
const START_CHARS_LENGTH = 6;

// Better Auth's own generateId() charset (used for user/organization ids)
// is not RFC4122 UUID — only this app's own uuid() columns (projects.id,
// and apikey.id here, which we generate ourselves via randomUUID()) are.
// createdByUserId is validated against Better Auth's actual id shape
// (non-empty, bounded-length, safe charset) rather than a UUID regex.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BETTER_AUTH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Local compatibility wrapper: the rest of the app never imports
// `@better-auth/api-key` directly. If a Better Auth upgrade renames or
// removes `defaultKeyHasher`, this is the only call site to update, and
// test/db/api-key-hash-compat.test.ts is the regression test to re-run.
export async function hashApiKeySecret(plaintext: string): Promise<string> {
  return betterAuthDefaultKeyHasher(plaintext);
}

export interface ApiKeyMetadata {
  projectId: string;
  createdByUserId: string;
  revokedAt: string | null;
  rotatedFromKeyId: string | null;
  rotatedToKeyId: string | null;
}

export interface ApiKeyRow {
  id: string;
  name: string | null;
  prefix: string | null;
  start: string | null;
  enabled: boolean;
  createdAt: Date;
  expiresAt: Date | null;
  lastRequest: Date | null;
  metadata: ApiKeyMetadata | null;
}

// Shared fail-closed metadata validator — used both when reading our own
// stored rows (parseAndValidateMetadata, below) and when validating the
// metadata object Better Auth's own auth.api.verifyApiKey hands back at
// render time (src/services/render-api-key-auth-service.ts). Better Auth's
// verify path checks the secret/enabled/expiresAt only — it never
// validates metadata *shape* — so this is the only place that does.
export function validateApiKeyMetadataObject(parsed: unknown): ApiKeyMetadata | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  if (typeof obj['projectId'] !== 'string' || !UUID_RE.test(obj['projectId'])) return null;
  if (obj['createdByUserId'] !== undefined) {
    if (typeof obj['createdByUserId'] !== 'string' || !BETTER_AUTH_ID_RE.test(obj['createdByUserId'])) return null;
  }
  if (obj['revokedAt'] !== undefined && obj['revokedAt'] !== null) {
    if (typeof obj['revokedAt'] !== 'string' || Number.isNaN(Date.parse(obj['revokedAt']))) return null;
  }
  if (obj['rotatedFromKeyId'] !== undefined && obj['rotatedFromKeyId'] !== null) {
    if (typeof obj['rotatedFromKeyId'] !== 'string' || !UUID_RE.test(obj['rotatedFromKeyId'])) return null;
  }
  if (obj['rotatedToKeyId'] !== undefined && obj['rotatedToKeyId'] !== null) {
    if (typeof obj['rotatedToKeyId'] !== 'string' || !UUID_RE.test(obj['rotatedToKeyId'])) return null;
  }

  return {
    projectId: obj['projectId'],
    createdByUserId: (obj['createdByUserId'] as string | undefined) ?? '',
    revokedAt: (obj['revokedAt'] as string | undefined) ?? null,
    rotatedFromKeyId: (obj['rotatedFromKeyId'] as string | undefined) ?? null,
    rotatedToKeyId: (obj['rotatedToKeyId'] as string | undefined) ?? null,
  };
}

function parseAndValidateMetadata(raw: string | null): ApiKeyMetadata | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateApiKeyMetadataObject(parsed);
}

function toRow(row: typeof apikey.$inferSelect): ApiKeyRow {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    start: row.start,
    enabled: row.enabled ?? true,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastRequest: row.lastRequest,
    metadata: parseAndValidateMetadata(row.metadata),
  };
}

async function generateKeyMaterial(prefix: string): Promise<{ plaintext: string; hashed: string; start: string }> {
  const secret = randomBytes(KEY_SECRET_BYTES).toString('base64url');
  const plaintext = `${prefix}${secret}`;
  const hashed = await hashApiKeySecret(plaintext);
  return { plaintext, hashed, start: plaintext.slice(0, START_CHARS_LENGTH) };
}

export type RotateApiKeyResult =
  | { outcome: 'rotated'; key: ApiKeyRow & { key: string } }
  | { outcome: 'not_found' }
  | { outcome: 'already_revoked' }
  | { outcome: 'already_rotated' }
  | { outcome: 'expired' };

export function createApiKeyRepository(db: Database) {
  async function getApiKeyForProject(organizationId: string, projectId: string, keyId: string): Promise<ApiKeyRow | null> {
    const [row] = await db
      .select()
      .from(apikey)
      .where(and(eq(apikey.id, keyId), eq(apikey.referenceId, organizationId)))
      .limit(1);
    if (!row) return null;
    const parsed = toRow(row);
    // Fail closed: a row with no/invalid metadata, or metadata pointing at
    // a different project, is never treated as belonging to this project.
    if (!parsed.metadata || parsed.metadata.projectId !== projectId) return null;
    return parsed;
  }

  return {
    getApiKeyForProject,

    async createApiKeyForProject(params: {
      organizationId: string;
      name: string;
      prefix: string;
      expiresAt: Date;
      rateLimitMax: number;
      rateLimitTimeWindowMs: number;
      metadata: ApiKeyMetadata;
    }): Promise<ApiKeyRow & { key: string }> {
      const { plaintext, hashed, start } = await generateKeyMaterial(params.prefix);
      const now = new Date();

      const [row] = await db
        .insert(apikey)
        .values({
          id: randomUUID(),
          configId: 'default',
          name: params.name,
          prefix: params.prefix,
          start,
          key: hashed,
          referenceId: params.organizationId,
          enabled: true,
          rateLimitEnabled: true,
          rateLimitMax: params.rateLimitMax,
          rateLimitTimeWindow: params.rateLimitTimeWindowMs,
          requestCount: 0,
          expiresAt: params.expiresAt,
          createdAt: now,
          updatedAt: now,
          metadata: JSON.stringify(params.metadata),
        })
        .returning();

      return { ...toRow(row!), key: plaintext };
    },

    async listApiKeysForProject(organizationId: string, projectId: string): Promise<ApiKeyRow[]> {
      const rows = await db.select().from(apikey).where(eq(apikey.referenceId, organizationId));
      return rows.map(toRow).filter((r) => r.metadata?.projectId === projectId);
    },

    async setEnabledAndMetadataForProject(
      organizationId: string,
      projectId: string,
      keyId: string,
      enabled: boolean,
      metadata: ApiKeyMetadata,
    ): Promise<boolean> {
      const existing = await getApiKeyForProject(organizationId, projectId, keyId);
      if (!existing) return false;
      await db
        .update(apikey)
        .set({ enabled, metadata: JSON.stringify(metadata), updatedAt: new Date() })
        .where(and(eq(apikey.id, keyId), eq(apikey.referenceId, organizationId)));
      return true;
    },

    // Atomic rotation: the entire read-check-write sequence runs inside
    // one Postgres transaction, with the original row locked via
    // `SELECT ... FOR UPDATE` for the duration. A second concurrent
    // rotation attempt on the same key blocks on that row lock until the
    // first transaction commits (or rolls back); once unblocked, it
    // re-reads the row inside its own transaction and sees the
    // already-updated `enabled=false`/`rotatedToKeyId` state, so it
    // deterministically fails with 'already_rotated' rather than creating
    // a second successor. No compensating "restore the old key" step
    // exists or is needed: if the insert of the new row fails for any
    // reason, Postgres rolls back the whole transaction and the original
    // row's `enabled`/`metadata` are exactly as they were before.
    async rotateApiKeyForProject(params: {
      organizationId: string;
      projectId: string;
      keyId: string;
      name: string;
      prefix: string;
      expiresAt: Date;
      rateLimitMax: number;
      rateLimitTimeWindowMs: number;
      createdByUserId: string;
    }): Promise<RotateApiKeyResult> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(apikey)
          .where(and(eq(apikey.id, params.keyId), eq(apikey.referenceId, params.organizationId)))
          .for('update');

        if (!row) return { outcome: 'not_found' };
        const existing = toRow(row);
        if (!existing.metadata || existing.metadata.projectId !== params.projectId) {
          return { outcome: 'not_found' };
        }
        if (!existing.enabled || existing.metadata.revokedAt) {
          return { outcome: 'already_revoked' };
        }
        if (existing.metadata.rotatedToKeyId) {
          return { outcome: 'already_rotated' };
        }
        if (existing.expiresAt && existing.expiresAt.getTime() <= Date.now()) {
          return { outcome: 'expired' };
        }

        const { plaintext, hashed, start } = await generateKeyMaterial(params.prefix);
        const newId = randomUUID();
        const now = new Date();

        const newMetadata: ApiKeyMetadata = {
          projectId: params.projectId,
          createdByUserId: params.createdByUserId,
          revokedAt: null,
          rotatedFromKeyId: params.keyId,
          rotatedToKeyId: null,
        };

        await tx.insert(apikey).values({
          id: newId,
          configId: 'default',
          name: params.name,
          prefix: params.prefix,
          start,
          key: hashed,
          referenceId: params.organizationId,
          enabled: true,
          rateLimitEnabled: true,
          rateLimitMax: params.rateLimitMax,
          rateLimitTimeWindow: params.rateLimitTimeWindowMs,
          requestCount: 0,
          expiresAt: params.expiresAt,
          createdAt: now,
          updatedAt: now,
          metadata: JSON.stringify(newMetadata),
        });

        const revokedMetadata: ApiKeyMetadata = {
          ...existing.metadata,
          revokedAt: now.toISOString(),
          rotatedToKeyId: newId,
        };
        await tx
          .update(apikey)
          .set({ enabled: false, metadata: JSON.stringify(revokedMetadata), updatedAt: now })
          .where(eq(apikey.id, params.keyId));

        return {
          outcome: 'rotated',
          key: {
            id: newId,
            name: params.name,
            prefix: params.prefix,
            start,
            enabled: true,
            createdAt: now,
            expiresAt: params.expiresAt,
            lastRequest: null,
            metadata: newMetadata,
            key: plaintext,
          },
        };
      });
    },
  };
}

export type ApiKeyRepository = ReturnType<typeof createApiKeyRepository>;

// Exported only for the compatibility test — asserts the pinned
// @better-auth/api-key version still ships this export under this name.
export { betterAuthDefaultKeyHasher as __betterAuthDefaultKeyHasherForCompatTest };
