import type { AuditAction, AuditResult, TenantAuditAction } from '../lib/audit-events.js';

export interface CreateAuditEventInput {
  organizationId: string;
  actorUserId: string | null;
  actorApiKeyId: string | null;
  action: TenantAuditAction;
  targetType: string;
  targetId: string | null;
  result: AuditResult;
  errorCode: string | null;
  requestId: string | null;
  // Already validated/allowlisted by src/lib/audit-events.ts's
  // buildAuditMetadata() before it reaches here — this layer does not
  // re-validate, it only persists.
  metadata: Record<string, unknown> | null;
}

export interface AuditEventRow {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  actorApiKeyId: string | null;
  action: AuditAction;
  targetType: string;
  targetId: string | null;
  result: AuditResult;
  errorCode: string | null;
  requestId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AuditEventCursor {
  createdAt: Date;
  id: string;
}

export interface ListAuditEventsForOrganizationParams {
  organizationId: string;
  limit: number;
  cursor?: AuditEventCursor | null;
  action?: AuditAction;
  result?: AuditResult;
  targetType?: string;
}

// Every method below requires organizationId — there is no unscoped
// lookup. See src/repositories/postgres/audit-repository.ts for the only
// implementation; management routes must go through this interface, never
// a raw Drizzle query, so tenant scoping can't be forgotten at a call site.
export interface AuditRepository {
  createAuditEvent(input: CreateAuditEventInput): Promise<AuditEventRow>;
  listAuditEventsForOrganization(params: ListAuditEventsForOrganizationParams): Promise<AuditEventRow[]>;
}
