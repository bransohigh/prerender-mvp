// Temporary, generation-only config for `npx @better-auth/cli generate`.
// Not imported by the running application — src/auth/auth.ts is the real
// factory, constructed with the app's actual pg.Pool. This file exists
// only so the CLI can introspect the plugin schema and emit Drizzle table
// definitions, which get merged into src/db/schema.ts by hand and then
// turned into a real migration via `npm run db:generate`.
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins/organization';
import { apiKey } from '@better-auth/api-key';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './src/db/schema.js';

const db = drizzle.mock({ schema });

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  secret: 'generation-only-placeholder-secret-not-used-32chars',
  baseURL: 'http://localhost:3000',
  emailAndPassword: { enabled: true },
  plugins: [
    organization(),
    apiKey({ references: 'organization', enableMetadata: true }),
  ],
});
