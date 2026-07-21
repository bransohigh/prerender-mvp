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

// Migration note (Phase 7 / Checkpoint 3B): global ADMIN_API_KEY and
// RENDER_API_KEY have been removed entirely — management endpoints use
// only Better Auth browser sessions, and /v1/render uses only
// project-scoped API keys (x-render-api-key header, verified via
// src/services/render-api-key-auth-service.ts). There is no fallback from
// a project key to any global key. See AUTHENTICATION.md / TENANCY.md for
// the breaking-change note.
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

    // Process-local rate limits (see src/lib/rate-limiter.ts). Not shared
    // across instances — documented limitation, not a Redis-backed limiter.
    RENDER_KEY_INVALID_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000).default(20),
    RENDER_KEY_INVALID_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
    RENDER_KEY_VALID_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(120),
    RENDER_KEY_VALID_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
    LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000).default(10),
    LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
    INVITATION_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000).default(10),
    INVITATION_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  })
  .transform((raw) => ({
    ...raw,
    AUTH_TRUSTED_ORIGINS: parseTrustedOrigins(raw.AUTH_TRUSTED_ORIGINS, raw.NODE_ENV === 'production'),
  }));

export const env = envSchema.parse(process.env);
