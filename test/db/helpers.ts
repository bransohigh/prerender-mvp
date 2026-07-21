import { sql } from 'drizzle-orm';
import { createDbClient, type DbClient } from '../../src/db/client.js';

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

export async function truncateAll(client: DbClient): Promise<void> {
  await client.db.execute(
    sql`TRUNCATE TABLE discovered_urls, sitemap_sources, domains, projects,
      audit_events, invitations, apikey, invitation, member, organization,
      session, account, verification, "user"
      RESTART IDENTITY CASCADE`,
  );
}
