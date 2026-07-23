import type { auditActionEnum, auditResultEnum } from '../db/schema.js';

export type AuditAction = (typeof auditActionEnum.enumValues)[number];
export type AuditResult = (typeof auditResultEnum.enumValues)[number];

// Every action that is actually written to audit_events in this checkpoint
// requires a real organizationId — auth.login.success/failure/logout stay
// declared in the DB enum (see src/db/schema.ts) but are deliberately never
// passed here; they are pre-tenant and go through recordAuthSecurityEvent
// in src/lib/security-events.ts instead.
export type TenantAuditAction = Exclude<AuditAction, 'auth.login.success' | 'auth.login.failure' | 'auth.logout'>;

export type AuditActor =
  | { type: 'user'; userId: string }
  | { type: 'api_key'; apiKeyId: string }
  | { type: 'system' };

// Allowlisted audit metadata keys (src/db/schema.ts's audit_events.metadata
// jsonb column). Never widen this without checking against the "never
// include" list in the Checkpoint 3C spec — plaintext secrets, tokens,
// hashes, full URLs, request bodies/headers must never reach this table.
const ALLOWED_METADATA_KEYS = new Set([
  'roleBefore',
  'roleAfter',
  'verificationMethod',
  'discoveredCount',
  'sitemapType',
  'apiKeyName',
  'apiKeyPrefix',
  'projectStatusBefore',
  'projectStatusAfter',
  'organizationStatusBefore',
  'organizationStatusAfter',
  'reasonCode',
  'safeOrigin',
]) as ReadonlySet<string>;

export type AuditMetadataValue = string | number | boolean | null;
export type AuditMetadataInput = Readonly<Record<string, AuditMetadataValue | undefined>>;

export class AuditMetadataError extends Error {}

// Fails closed: an unknown key or a non-primitive value throws rather than
// being silently stripped, so a caller passing something unexpected (e.g.
// a raw URL or an object) fails loudly in tests/CI instead of quietly
// reaching the database.
export function buildAuditMetadata(input: AuditMetadataInput): Record<string, AuditMetadataValue> {
  const out: Record<string, AuditMetadataValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!ALLOWED_METADATA_KEYS.has(key)) {
      throw new AuditMetadataError(`Audit metadata key is not allowlisted: ${key}`);
    }
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new AuditMetadataError(`Audit metadata value for "${key}" must be a string, number, boolean, or null`);
    }
    if (typeof value === 'string' && value.length > 500) {
      throw new AuditMetadataError(`Audit metadata value for "${key}" exceeds 500 characters`);
    }
    out[key] = value;
  }
  return out;
}

// protocol + normalized (lowercased) hostname + explicit port only when
// non-default for that protocol — never path, query, fragment, or
// credentials. Used for the "safeOrigin" metadata field only; never store
// a full URL.
export function safeOrigin(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const isDefaultPort =
    parsed.port === '' ||
    (parsed.protocol === 'https:' && parsed.port === '443') ||
    (parsed.protocol === 'http:' && parsed.port === '80');
  const host = parsed.hostname.toLowerCase();
  return isDefaultPort ? `${parsed.protocol}//${host}` : `${parsed.protocol}//${host}:${parsed.port}`;
}

export interface ActorFields {
  actorUserId: string | null;
  actorApiKeyId: string | null;
}

// Enforces the actor-consistency rule from the Checkpoint 3C spec: exactly
// one of (user, api key, system) — never both a user and an api key unless
// a future action explicitly documents why, and never a fabricated actor.
export function resolveActorFields(actor: AuditActor): ActorFields {
  switch (actor.type) {
    case 'user':
      return { actorUserId: actor.userId, actorApiKeyId: null };
    case 'api_key':
      return { actorUserId: null, actorApiKeyId: actor.apiKeyId };
    case 'system':
      return { actorUserId: null, actorApiKeyId: null };
  }
}

export type AuditActorType = 'user' | 'api_key' | 'system';

export class AuditActorConsistencyError extends Error {}

// Read-path check on a stored row: a row with BOTH actor ids set is a data
// integrity violation (never producible via resolveActorFields on the
// write path, so this only fires on drift — a manual DB edit, a future
// bug, or a legacy row) — never silently pass such a row through as if it
// belonged to one identifiable actor.
export function deriveActorType(fields: ActorFields): AuditActorType {
  if (fields.actorUserId && fields.actorApiKeyId) {
    throw new AuditActorConsistencyError('Audit row has both actorUserId and actorApiKeyId set');
  }
  if (fields.actorUserId) return 'user';
  if (fields.actorApiKeyId) return 'api_key';
  return 'system';
}

// Read-path metadata sanitizer: unlike buildAuditMetadata (write path,
// fails closed by throwing), this NEVER throws — a malformed or legacy
// metadata blob must not break the audit list endpoint for every other
// row. Unknown keys/non-primitive values/oversized strings are silently
// dropped; a fully malformed value yields an empty object.
export function sanitizeStoredMetadata(raw: unknown): Record<string, AuditMetadataValue> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, AuditMetadataValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) continue;
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    if (typeof value === 'string' && value.length > 500) continue;
    out[key] = value;
  }
  return out;
}
