import type { AuditRepository, AuditEventRow, AuditEventCursor } from '../repositories/audit-repository.js';
import {
  buildAuditMetadata,
  resolveActorFields,
  type AuditActor,
  type AuditMetadataInput,
  type AuditResult,
  type TenantAuditAction,
  type AuditAction,
} from '../lib/audit-events.js';

export interface RecordAuditEventInput {
  organizationId: string;
  actor: AuditActor;
  action: TenantAuditAction;
  targetType: string;
  targetId?: string | null;
  result: AuditResult;
  errorCode?: string | null;
  requestId?: string | null;
  metadata?: AuditMetadataInput;
}

export interface ListAuditEventsInput {
  organizationId: string;
  limit?: number;
  cursor?: string | null;
  action?: AuditAction;
  result?: AuditResult;
  targetType?: string;
}

export interface AuditEventPage {
  items: AuditEventRow[];
  nextCursor: string | null;
}

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

export class InvalidAuditCursorError extends Error {}

// Opaque, URL-safe pagination token — not meant to be parsed by clients,
// just round-tripped. Encodes (createdAt, id) for stable createdAt
// DESC, id DESC ordering.
export function encodeAuditCursor(cursor: AuditEventCursor): string {
  const payload = `${cursor.createdAt.toISOString()}|${cursor.id}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeAuditCursor(token: string): AuditEventCursor {
  let payload: string;
  try {
    payload = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    throw new InvalidAuditCursorError('Malformed cursor');
  }
  const separatorIndex = payload.indexOf('|');
  if (separatorIndex <= 0) {
    throw new InvalidAuditCursorError('Malformed cursor');
  }
  const isoTimestamp = payload.slice(0, separatorIndex);
  const id = payload.slice(separatorIndex + 1);
  const createdAt = new Date(isoTimestamp);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
    throw new InvalidAuditCursorError('Malformed cursor');
  }
  return { createdAt, id };
}

export interface AuditService {
  record(input: RecordAuditEventInput): Promise<AuditEventRow>;
  list(input: ListAuditEventsInput): Promise<AuditEventPage>;
}

// Standalone (non-transactional) writes only — actions that participate in
// another mutation's own db.transaction() call insertAuditEventRow()
// directly inside that transaction instead (see
// src/repositories/postgres/audit-repository.ts), so a failed audit
// insert rolls back the mutation rather than silently diverging from it.
export function createAuditService(repository: AuditRepository): AuditService {
  return {
    async record(input: RecordAuditEventInput): Promise<AuditEventRow> {
      const actorFields = resolveActorFields(input.actor);
      const metadata = input.metadata ? buildAuditMetadata(input.metadata) : null;
      return repository.createAuditEvent({
        organizationId: input.organizationId,
        actorUserId: actorFields.actorUserId,
        actorApiKeyId: actorFields.actorApiKeyId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        result: input.result,
        errorCode: input.errorCode ?? null,
        requestId: input.requestId ?? null,
        metadata,
      });
    },

    async list(input: ListAuditEventsInput): Promise<AuditEventPage> {
      const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
      const cursor = input.cursor ? decodeAuditCursor(input.cursor) : null;
      // Fetch one extra row to know whether a next page exists without a
      // separate count query.
      const rows = await repository.listAuditEventsForOrganization({
        organizationId: input.organizationId,
        limit: limit + 1,
        cursor,
        action: input.action,
        result: input.result,
        targetType: input.targetType,
      });
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id }) : null;
      return { items, nextCursor };
    },
  };
}
