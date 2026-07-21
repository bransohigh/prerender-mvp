import { eq, isNull } from 'drizzle-orm';
import { projects, organization as organizationTable } from '../db/schema.js';
import type { Database } from '../db/client.js';

export class TenancyBackfillError extends Error {}

export interface BackfillResult {
  affectedRowCount: number;
  dryRun: boolean;
}

// Expand/migrate/contract, stage 2 of 3 (see drizzle/0002_* and the later
// NOT NULL migration): assigns every project with a NULL organizationId to
// one explicitly chosen organization. Never guesses or silently picks an
// organization — the caller (CLI) must supply --organization-id.
export async function backfillProjectsToOrganization(
  db: Database,
  organizationId: string,
  options: { dryRun: boolean },
): Promise<BackfillResult> {
  if (!/^[0-9a-zA-Z_-]{1,255}$/.test(organizationId)) {
    throw new TenancyBackfillError('Invalid organization id format.');
  }

  const org = await db.query.organization.findFirst({ where: eq(organizationTable.id, organizationId) });
  if (!org) {
    throw new TenancyBackfillError(`Target organization does not exist: ${organizationId}`);
  }

  const orphans = await db.select({ id: projects.id }).from(projects).where(isNull(projects.organizationId));

  if (options.dryRun) {
    return { affectedRowCount: orphans.length, dryRun: true };
  }

  if (orphans.length === 0) {
    return { affectedRowCount: 0, dryRun: false };
  }

  return db.transaction(async (tx) => {
    const result = await tx
      .update(projects)
      .set({ organizationId, updatedAt: new Date() })
      .where(isNull(projects.organizationId))
      .returning({ id: projects.id });
    return { affectedRowCount: result.length, dryRun: false };
  });
}

// Used before the NOT NULL migration is applied: refuses to let the caller
// believe backfill succeeded if any orphan rows remain (e.g. a project
// inserted concurrently after backfill ran).
export async function countOrphanProjects(db: Database): Promise<number> {
  const rows = await db.select({ id: projects.id }).from(projects).where(isNull(projects.organizationId));
  return rows.length;
}
