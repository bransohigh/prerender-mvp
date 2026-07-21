import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DbClient {
  db: Database;
  pool: pg.Pool;
  ping: (timeoutMs?: number) => Promise<boolean>;
  close: () => Promise<void>;
}

export function createDbClient(databaseUrl: string): DbClient {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // Pool-level errors on idle clients must not crash the process.
  pool.on('error', (err) => {
    console.error('Postgres pool error (ignored):', err.message);
  });

  const db = drizzle(pool, { schema });

  async function ping(timeoutMs = 2000): Promise<boolean> {
    try {
      await Promise.race([
        db.execute(sql`select 1`),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('db ping timeout')), timeoutMs),
        ),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async function close(): Promise<void> {
    await pool.end();
  }

  return { db, pool, ping, close };
}
