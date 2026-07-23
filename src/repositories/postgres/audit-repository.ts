import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { auditEvents } from '../../db/schema.js';
import { createNoopMetrics, type Metrics } from '../../lib/metrics.js';
import type {
  AuditRepository,
  AuditEventRow,
  CreateAuditEventInput,
  ListAuditEventsForOrganizationParams,
} from '../audit-repository.js';

// A metrics.incrementAuditEvent call is only ever correct AFTER the
// surrounding transaction has actually committed — incrementing "success"
// from inside insertAuditEventRow would fire even when the transaction
// this insert is part of later rolls back for an unrelated reason (e.g. a
// later statement in the same tx fails), which would report an audit
// write that was never actually persisted. See callers below and in
// src/repositories/postgres/{tenant,api-key}-repository.ts and
// src/services/invitation-service.ts, all of which increment the metric
// themselves only once their enclosing db.transaction(...) call has
// resolved (success) or rejected AFTER this function was reached
// (failure) — never inside this function itself.

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

// Shared by every "mutation + audit row in one transaction" call site
// (src/repositories/postgres/{tenant,api-key}-repository.ts,
// src/services/invitation-service.ts): runs `fn` inside db.transaction(),
// and only after that promise has resolved (committed) does it increment
// the audit metric — never from inside the transaction, and never at all
// if `fn` never actually attempted an audit insert (e.g. an early
// "not found" return null before reaching insertAuditEventRow). `fn`
// reports which action it audited (if any) via the returned `auditedAction`
// field so this wrapper never has to guess. On rollback, the failure
// metric fires at most once, and only if an audit insert had actually
// been attempted before the failure — a business-validation failure (a
// slug conflict, say) that never reached the audit insert increments
// nothing, since that's not an audit-system failure.
export async function runAuditedTransaction<T>(
  db: Database,
  metrics: Metrics,
  fn: (tx: Database, setAuditedAction: (action: CreateAuditEventInput['action']) => void) => Promise<T>,
): Promise<T> {
  // Set via closure mutation from inside the transaction callback (call it
  // right before insertAuditEventRow) — this is visible in the outer
  // scope whether the transaction promise later resolves OR rejects,
  // which a value returned only on success would not be.
  let auditedAction: CreateAuditEventInput['action'] | null = null;
  let result: T;
  try {
    result = await db.transaction((tx) => fn(tx, (action) => { auditedAction = action; }));
  } catch (err) {
    // The metrics call itself must never mask the real error, or turn an
    // already-decided rollback into a different-looking failure — catch
    // and drop any exception from the metrics client itself.
    if (auditedAction) {
      try {
        metrics.incrementAuditEvent(auditedAction, 'failure');
      } catch {
        // ignored — see above.
      }
    }
    throw err;
  }
  // The mutation is already committed by this point — a metrics-client
  // error here must not "un-succeed" it or propagate to the caller.
  if (auditedAction) {
    try {
      metrics.incrementAuditEvent(auditedAction, 'success');
    } catch {
      // ignored — see above.
    }
  }
  return result;
}

export function createPostgresAuditRepository(db: Database, metrics: Metrics = createNoopMetrics()): AuditRepository {
  return {
    // A standalone (non-paired-transaction) write: `db.insert(...)` here is
    // its own implicit one-statement transaction, so "the insert promise
    // resolved" IS "committed" — safe to increment success immediately
    // after, and failure only if this insert itself actually threw.
    async createAuditEvent(input: CreateAuditEventInput): Promise<AuditEventRow> {
      let row: AuditEventRow;
      try {
        row = await insertAuditEventRow(db, input);
      } catch (err) {
        try {
          metrics.incrementAuditEvent(input.action, 'failure');
        } catch {
          // A metrics-client error must never mask the real insert error.
        }
        throw err;
      }
      try {
        metrics.incrementAuditEvent(input.action, 'success');
      } catch {
        // The row is already committed — a metrics-client error here must
        // not turn a successful write into a thrown error for the caller.
      }
      return row;
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
