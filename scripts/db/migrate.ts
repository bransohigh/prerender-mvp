import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('FATAL: DATABASE_URL is required to run migrations');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const db = drizzle(pool);

try {
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations applied successfully.');
  process.exit(0);
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
} finally {
  await pool.end();
}
