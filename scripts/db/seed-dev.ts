// Development-only convenience seed. Refuses to run unless NODE_ENV is
// explicitly "development" — never touches production data, contains no
// secrets or real domains, and CI tests do not depend on it.
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../src/db/schema.js';
import { hashVerificationToken, generateVerificationToken } from '../../src/lib/verification-token.js';

if (process.env['NODE_ENV'] !== 'development') {
  console.error('FATAL: db:seed:dev only runs when NODE_ENV=development. Refusing to run.');
  process.exit(1);
}

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('FATAL: DATABASE_URL is required to seed the database');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const db = drizzle(pool, { schema });

try {
  const [project] = await db
    .insert(schema.projects)
    .values({ name: 'Local Dev Project', slug: 'local-dev-project' })
    .onConflictDoNothing({ target: schema.projects.slug })
    .returning();

  if (project) {
    const token = generateVerificationToken();
    await db.insert(schema.domains).values({
      projectId: project.id,
      hostname: 'example.invalid',
      normalizedHostname: 'example.invalid',
      verificationMethod: 'dns_txt',
      verificationTokenHash: hashVerificationToken(token),
    });
    console.log('Seeded dev project + domain (example.invalid, not verifiable — for local UI/testing only).');
  } else {
    console.log('Dev project already exists, skipping seed.');
  }
  process.exit(0);
} catch (err) {
  console.error('Seed failed:', err);
  process.exit(1);
} finally {
  await pool.end();
}
