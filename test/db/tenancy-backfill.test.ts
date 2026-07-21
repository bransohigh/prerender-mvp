import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createTestDbClient, truncateAll, createFixtureOrganization } from './helpers.js';
import {
  backfillProjectsToOrganization,
  countOrphanProjects,
  TenancyBackfillError,
} from '../../src/services/tenancy-backfill-service.js';
import { projects } from '../../src/db/schema.js';
import type { DbClient } from '../../src/db/client.js';

let client: DbClient;

beforeEach(async () => {
  client ??= createTestDbClient();
  await truncateAll(client);
});

afterAll(async () => {
  await client?.close();
});

// Simulates a pre-migration-0002 orphan row: bypasses the app layer (which
// can no longer insert a NULL organizationId post-0002) with a raw SQL
// insert that temporarily relaxes the NOT NULL constraint, matching what a
// real pre-tenancy installation's data would look like at expand-phase.
async function insertOrphanProject(client: DbClient, slug: string): Promise<string> {
  await client.db.execute(sql`ALTER TABLE projects ALTER COLUMN organization_id DROP NOT NULL`);
  const result = (await client.db.execute(
    sql`INSERT INTO projects (name, slug, organization_id) VALUES (${'Orphan'}, ${slug}, NULL) RETURNING id`,
  )) as unknown as { rows: Array<{ id: string }> };
  return result.rows[0]!.id;
}

async function restoreNotNullIfNeeded(client: DbClient): Promise<void> {
  await client.db.execute(sql`ALTER TABLE projects ALTER COLUMN organization_id SET NOT NULL`).catch(() => {});
}

describe('tenancy backfill + NOT NULL migration', () => {
  it('existing project rows survive the expand migration (nullable organizationId already applied)', async () => {
    const organizationId = await createFixtureOrganization(client);
    const [row] = await client.db
      .insert(projects)
      .values({ name: 'Survivor', slug: 'survivor', organizationId })
      .returning();
    expect(row?.id).toBeTruthy();

    const found = await client.db.select().from(projects).where(eq(projects.id, row!.id));
    expect(found).toHaveLength(1);
    expect(found[0]!.organizationId).toBe(organizationId);
  });

  it('dry-run reports the orphan count but changes nothing', async () => {
    const organizationId = await createFixtureOrganization(client);
    await insertOrphanProject(client, 'orphan-dry-run');

    const result = await backfillProjectsToOrganization(client.db, organizationId, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.affectedRowCount).toBe(1);

    const stillOrphaned = await countOrphanProjects(client.db);
    expect(stillOrphaned).toBe(1);
    await restoreNotNullIfNeeded(client);
  });

  it('real backfill assigns the selected organization to all orphan rows', async () => {
    const organizationId = await createFixtureOrganization(client);
    await insertOrphanProject(client, 'orphan-real-1');
    await insertOrphanProject(client, 'orphan-real-2');

    const result = await backfillProjectsToOrganization(client.db, organizationId, { dryRun: false });
    expect(result.affectedRowCount).toBe(2);

    const remaining = await countOrphanProjects(client.db);
    expect(remaining).toBe(0);

    const rows = await client.db.select().from(projects).where(eq(projects.organizationId, organizationId));
    expect(rows.map((r) => r.slug).sort()).toEqual(['orphan-real-1', 'orphan-real-2']);
    await restoreNotNullIfNeeded(client);
  });

  it('rejects an invalid organization id format', async () => {
    await expect(
      backfillProjectsToOrganization(client.db, 'not a valid id !!', { dryRun: true }),
    ).rejects.toThrow(TenancyBackfillError);
  });

  it('fails when the target organization does not exist', async () => {
    await expect(
      backfillProjectsToOrganization(client.db, 'org_does_not_exist_xyz', { dryRun: false }),
    ).rejects.toThrow(TenancyBackfillError);
  });

  it('rerunning backfill after success is a safe no-op (no corruption, no error)', async () => {
    const organizationId = await createFixtureOrganization(client);
    await insertOrphanProject(client, 'orphan-rerun');

    const first = await backfillProjectsToOrganization(client.db, organizationId, { dryRun: false });
    expect(first.affectedRowCount).toBe(1);

    const second = await backfillProjectsToOrganization(client.db, organizationId, { dryRun: false });
    expect(second.affectedRowCount).toBe(0);

    const rows = await client.db.select().from(projects).where(eq(projects.organizationId, organizationId));
    expect(rows).toHaveLength(1);
    await restoreNotNullIfNeeded(client);
  });

  it('the NOT NULL constraint rejects a direct insert with a NULL organizationId (migration behavior)', async () => {
    await expect(
      client.db.execute(sql`INSERT INTO projects (name, slug, organization_id) VALUES ('X', 'x-null-test', NULL)`),
    ).rejects.toThrow();
  });

  it('a foreign key rejects assigning a project to a non-existent organization', async () => {
    await expect(
      client.db.execute(
        sql`INSERT INTO projects (name, slug, organization_id) VALUES ('X', 'x-fk-test', 'org_does_not_exist_xyz')`,
      ),
    ).rejects.toThrow();
  });

  it('SET NOT NULL fails while an orphan (NULL organizationId) row still exists', async () => {
    await insertOrphanProject(client, 'orphan-blocks-not-null');
    await expect(
      client.db.execute(sql`ALTER TABLE projects ALTER COLUMN organization_id SET NOT NULL`),
    ).rejects.toThrow();
    // Clean up: relax again so truncateAll/other tests aren't affected by
    // a lingering NULL row under a NOT NULL constraint mismatch.
    const orphanCount = await countOrphanProjects(client.db);
    expect(orphanCount).toBe(1);
  });

  it('SET NOT NULL succeeds once backfill has eliminated all orphans', async () => {
    const organizationId = await createFixtureOrganization(client);
    await insertOrphanProject(client, 'orphan-then-not-null');
    await backfillProjectsToOrganization(client.db, organizationId, { dryRun: false });
    await expect(
      client.db.execute(sql`ALTER TABLE projects ALTER COLUMN organization_id SET NOT NULL`),
    ).resolves.toBeDefined();
  });

  it('deleting an organization cascades to its projects (documented, not silent)', async () => {
    // organization -> projects FK is `onDelete: 'cascade'` by explicit
    // design (src/db/schema.ts) — this test documents and pins that
    // behavior rather than leaving it implicit.
    const organizationId = await createFixtureOrganization(client);
    await client.db.insert(projects).values({ name: 'Cascade Me', slug: 'cascade-me', organizationId });

    const { organization } = await import('../../src/db/schema.js');
    await client.db.delete(organization).where(eq(organization.id, organizationId));

    const remaining = await client.db.select().from(projects).where(eq(projects.organizationId, organizationId));
    expect(remaining).toHaveLength(0);
  });
});
