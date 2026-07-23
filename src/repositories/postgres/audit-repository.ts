import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { auditEvents } from '../../db/schema.js';
import type {
  AuditRepository,
  AuditEventRow,
  CreateAuditEventInput,
  ListAuditEventsForOrganizationParams,
} from '../audit-repository.js';

function toRow(row: typeof auditEvents.$inferSelect): AuditEventRow {
  return {
    id: row.id,
    organizationId: row.organizationId as string,
    actorUserId: row.actorUserId,
    actorApiKeyId: row.actorApiKeyId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    result: row.result,
    errorCode: row.errorCode,
    requestId: row.requestId,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
  };
}

// Exported separately from AuditRepository so other repositories can
// insert an audit row inside their OWN db.transaction(tx => ...) callback
// — Drizzle's tx object has the same query-builder shape as Database, so
// this works identically whether `executor` is the top-level db or a tx.
// This is how the transactional-pairing requirement (mutation + audit
// commit together, or neither does) is satisfied without a nested/second
// transaction.
export async function insertAuditEventRow(executor: Database, input: CreateAuditEventInput): Promise<AuditEventRow> {
  const [row] = await executor
    .insert(auditEvents)
    .values({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      actorApiKeyId: input.actorApiKeyId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      result: input.result,
      errorCode: input.errorCode,
      requestId: input.requestId,
      metadata: input.metadata,
    })
    .returning();
  if (!row) {
    throw new Error('Audit event insert returned no row');
  }
  return toRow(row);
}

export function createPostgresAuditRepository(db: Database): AuditRepository {
  return {
    async createAuditEvent(input: CreateAuditEventInput): Promise<AuditEventRow> {
      return insertAuditEventRow(db, input);
    },

    async listAuditEventsForOrganization(params: ListAuditEventsForOrganizationParams): Promise<AuditEventRow[]> {
      const conditions = [eq(auditEvents.organizationId, params.organizationId)];
      if (params.action) conditions.push(eq(auditEvents.action, params.action));
      if (params.result) conditions.push(eq(auditEvents.result, params.result));
      if (params.targetType) conditions.push(eq(auditEvents.targetType, params.targetType));
      if (params.cursor) {
        const { createdAt, id } = params.cursor;
        const cursorCondition = or(
          lt(auditEvents.createdAt, createdAt),
          and(eq(auditEvents.createdAt, createdAt), lt(auditEvents.id, id)),
        );
        if (cursorCondition) conditions.push(cursorCondition);
      }

      const rows = await db
        .select()
        .from(auditEvents)
        .where(and(...conditions))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(params.limit);

      return rows.map(toRow);
    },
  };
}
