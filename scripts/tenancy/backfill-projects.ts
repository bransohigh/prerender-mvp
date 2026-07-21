import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../src/db/schema.js';
import { backfillProjectsToOrganization, TenancyBackfillError } from '../../src/services/tenancy-backfill-service.js';

// npm run tenancy:backfill-projects -- --organization-id <uuid> [--dry-run]
//
// Assigns every project row whose organizationId is still NULL (from
// installations that predate the tenancy migration) to one explicitly
// named organization. Must run, and complete with zero orphans, before the
// follow-up NOT NULL migration (drizzle/0003_*) can be applied.

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('FATAL: DATABASE_URL is required');
    process.exit(1);
  }

  const organizationId = readArg('organization-id');
  const dryRun = hasFlag('dry-run');

  if (!organizationId) {
    console.error('Usage: tenancy:backfill-projects -- --organization-id <id> [--dry-run]');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const db = drizzle(pool, { schema });

  try {
    const result = await backfillProjectsToOrganization(db, organizationId, { dryRun });
    if (result.dryRun) {
      console.log(`[dry-run] ${result.affectedRowCount} project(s) would be assigned to organization ${organizationId}.`);
    } else {
      console.log(`Backfill complete: ${result.affectedRowCount} project(s) assigned to organization ${organizationId}.`);
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof TenancyBackfillError) {
      console.error('Backfill failed:', err.message);
    } else {
      console.error('Backfill failed:', err instanceof Error ? err.message : err);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

void main();
