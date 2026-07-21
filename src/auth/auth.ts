import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins/organization';
import { apiKey } from '@better-auth/api-key';
import { env } from '../config/env.js';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema.js';

// One Better Auth instance, backed by the same Postgres connection/Drizzle
// schema as the rest of the app — no second ORM or DB connection layer.
//
// Deliberately NOT using organization()'s built-in invitation feature: this
// app's onboarding flow (POST /v1/organizations/:id/invitations,
// POST /v1/onboarding/accept) is custom-built with its own hashed,
// single-use, 24h-expiry tokens (src/services/invitation-service.ts),
// matching the same pattern already used for domain verification tokens.
// The organization plugin is used only for its organization/member data
// model and default owner/admin/member roles.
export function createAuth(db: Database) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_BASE_URL,
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: true,
    },
    session: {
      // Total lifetime and rolling-refresh window, both explicit.
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh once per day of activity
    },
    advanced: {
      cookiePrefix: 'prerender',
      useSecureCookies: env.NODE_ENV === 'production',
    },
    plugins: [
      organization(),
      apiKey({
        references: 'organization',
        defaultPrefix: 'pr_live_',
        enableMetadata: true,
        requireName: true,
        keyExpiration: {
          defaultExpiresIn: 90 * 24 * 60 * 60 * 1000,
          maxExpiresIn: 365,
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
