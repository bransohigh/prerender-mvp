import 'dotenv/config';
import { z } from 'zod';
import { parseTrustedOrigins } from '../lib/trusted-origins.js';

const proxyUrlSchema = z
  .string()
  .url()
  .refine((url) => new URL(url).protocol === 'http:', {
    message: 'Proxy URL must use http: scheme',
  })
  .refine((url) => !new URL(url).username && !new URL(url).password, {
    message: 'Proxy URL must not contain credentials',
  })
  .optional();

// Migration note (Phase 7, in progress): Better Auth is now the primary
// auth system — new organization/onboarding routes (src/routes/organizations.ts,
// src/routes/onboarding.ts) use ONLY session/invitation auth and must never
// read or fall back to ADMIN_API_KEY/RENDER_API_KEY.
//
// ADMIN_API_KEY / RENDER_API_KEY are TRANSITIONAL/DEPRECATED: the old
// unscoped project/domain/sitemap/render routes (src/routes/projects.ts,
// domains.ts, sitemaps.ts, render.ts) still authenticate with these global
// keys until Milestone 3 migrates them to session auth (management) and
// project-scoped API keys (render). They will be removed entirely once
// that migration lands — do not build new functionality on top of them.
// See AUTHENTICATION.md.
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.string().default('info'),
    RENDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
    MAX_HTML_BYTES: z.coerce.number().int().min(10000).max(20_000_000).default(5_000_000),
    MAX_CONCURRENT_RENDERS: z.coerce.number().int().min(1).max(50).default(2),
    MAX_QUEUED_RENDERS: z.coerce.number().int().min(0).max(500).default(20),
    RENDER_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(10000),
    OUTBOUND_PROXY_URL: proxyUrlSchema,
    // TRANSITIONAL (see note above) — removed in Milestone 3.
    ADMIN_API_KEY: z.string().min(32, 'ADMIN_API_KEY must be at least 32 characters'),
    RENDER_API_KEY: z.string().min(32, 'RENDER_API_KEY must be at least 32 characters'),
    REQUIRE_OUTBOUND_PROXY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    DATABASE_URL: z
      .string()
      .url()
      .refine((url) => new URL(url).protocol === 'postgres:' || new URL(url).protocol === 'postgresql:', {
        message: 'DATABASE_URL must be a postgres:// or postgresql:// connection string',
      }),
    BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
    BETTER_AUTH_BASE_URL: z.string().url(),
    AUTH_TRUSTED_ORIGINS: z.string().min(1, 'AUTH_TRUSTED_ORIGINS must be set'),
  })
  .transform((raw) => ({
    ...raw,
    AUTH_TRUSTED_ORIGINS: parseTrustedOrigins(raw.AUTH_TRUSTED_ORIGINS, raw.NODE_ENV === 'production'),
  }));

export const env = envSchema.parse(process.env);
