import { sql } from 'drizzle-orm';
import { createDbClient, type DbClient } from '../../src/db/client.js';
import { organization as organizationTable } from '../../src/db/schema.js';

// DB integration tests require DATABASE_URL to point at a real, migrated
// PostgreSQL instance (see README.md "PostgreSQL kurulumu" / CI database job).
// Truncates all tables between tests for isolation rather than requiring a
// fresh schema per test.
export function createTestDbClient(): DbClient {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set to run database integration tests');
  }
  return createDbClient(databaseUrl);
}

// Creates a bare organization row (no user/membership) purely to satisfy
// projects.organization_id's FK+NOT NULL constraint in tests that exercise
// the legacy, pre-tenancy repository/service layer directly and don't care
// about membership. Tenant-isolation tests use real bootstrap/invitation
// flows instead — see test/db/tenancy-*.test.ts.
export async function createFixtureOrganization(client: DbClient, idSuffix = ''): Promise<string> {
  const id = `org_fixture_${idSuffix || Date.now()}_${Math.random().toString(36).slice(2)}`;
  await client.db.insert(organizationTable).values({
    id,
    name: 'Fixture Org',
    slug: id,
    createdAt: new Date(),
  });
  return id;
}

export async function truncateAll(client: DbClient): Promise<void> {
  await client.db.execute(
    sql`TRUNCATE TABLE discovered_urls, sitemap_sources, domains, projects,
      audit_events, invitations, apikey, invitation, member, organization,
      session, account, verification, "user"
      RESTART IDENTITY CASCADE`,
  );
}
