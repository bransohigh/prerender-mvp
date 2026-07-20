import 'dotenv/config';
import { z } from 'zod';

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

const envSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  RENDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  MAX_HTML_BYTES: z.coerce.number().int().min(10000).max(20_000_000).default(5_000_000),
  API_KEY: z.string().min(8),
  MAX_CONCURRENT_RENDERS: z.coerce.number().int().min(1).max(50).default(2),
  MAX_QUEUED_RENDERS: z.coerce.number().int().min(0).max(500).default(20),
  RENDER_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(10000),
  OUTBOUND_PROXY_URL: proxyUrlSchema,
  REQUIRE_OUTBOUND_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  CHROMIUM_SANDBOX: z
    .enum(['true', 'false'])
    .default(process.platform === 'linux' ? 'true' : 'false')
    .transform((v) => v === 'true'),
});

export const env = envSchema.parse(process.env);
