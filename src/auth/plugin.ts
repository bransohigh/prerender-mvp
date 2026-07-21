import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Auth } from './auth.js';
import { env } from '../config/env.js';
import { createRateLimiter, type RateLimiter } from '../lib/rate-limiter.js';
import { normalizedEmailDigest } from '../lib/rate-limit-keys.js';

// Mounts Better Auth's handler under /api/auth/*, following the officially
// documented Fastify integration pattern (Better Auth ships Node/Next/Svelte
// adapters but no first-party Fastify plugin, so the Request/Response bridge
// is done by hand here). Registered with a raw body parser so the exact
// bytes Better Auth expects to verify/parse are preserved (Fastify's default
// JSON parser would otherwise consume and re-serialize the body, which is
// lossy for signed/encoded payloads).
export async function registerAuthRoutes(app: FastifyInstance, auth: Auth): Promise<void> {
  // Registered as a child scope so the raw-buffer content-type parser below
  // is encapsulated to /api/auth/* only and does not affect the JSON body
  // parsing used by the rest of the app's routes.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    registerAuthHandler(scope, auth);
  });
}

function registerAuthHandler(app: FastifyInstance, auth: Auth): void {
  // Process-local, keyed by IP and by an HMAC digest of the normalized
  // email (never the raw email — see src/lib/rate-limit-keys.ts). A
  // failed login only ever consumes the IP bucket if the body can't even
  // be parsed; once an email is extracted, both buckets are checked so a
  // distributed low-and-slow attempt against one email from many IPs is
  // still bounded, and a single IP hammering many emails is also bounded.
  const loginIpLimiter = createRateLimiter({ windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MS, maxAttempts: env.LOGIN_RATE_LIMIT_MAX });
  const loginEmailLimiter = createRateLimiter({ windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MS, maxAttempts: env.LOGIN_RATE_LIMIT_MAX });
  app.addHook('onClose', () => {
    loginIpLimiter.shutdown();
    loginEmailLimiter.shutdown();
  });

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/api/auth/*',
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      // No open public signup: onboarding is invite-only (POST
      // /v1/onboarding/accept), so Better Auth's own sign-up endpoint must
      // never be reachable.
      const path = (request.params as { '*'?: string })['*'] ?? '';
      if (path.startsWith('sign-up')) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      const body = hasBody ? (request.body as Buffer) : undefined;

      let loginEmailKey: string | undefined;
      if (request.method === 'POST' && path === 'sign-in/email') {
        loginEmailKey = extractLoginEmailKey(body);
        const rateDecision = checkLoginRateLimit(request, loginEmailKey, loginIpLimiter, loginEmailLimiter);
        if (!rateDecision.allowed) {
          return reply
            .code(429)
            .header('Retry-After', String(rateDecision.retryAfterSeconds))
            .send({ error: 'RATE_LIMITED', message: 'Too many requests', requestId: request.id });
        }
      }

      const url = new URL(request.url, `${request.protocol}://${request.hostname}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.append(key, value);
        }
      }

      const webRequest = new Request(url.toString(), {
        method: request.method,
        headers,
        body: body && body.length > 0 ? new Uint8Array(body) : undefined,
      });

      const response = await auth.handler(webRequest);

      // A successful login clears that email's failed-attempt bucket so
      // it doesn't inherit a permanent penalty from earlier failures —
      // the IP bucket is left as-is (still a meaningful signal on shared
      // IPs/NATs).
      if (request.method === 'POST' && path === 'sign-in/email' && response.status === 200 && loginEmailKey) {
        loginEmailLimiter.reset(loginEmailKey);
      }

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        // Fastify sets its own transfer-encoding/content-length; forwarding
        // the fetch Response's copies can conflict with Fastify's framing.
        if (key.toLowerCase() === 'transfer-encoding' || key.toLowerCase() === 'content-length') {
          return;
        }
        reply.header(key, value);
      });

      const buf = Buffer.from(await response.arrayBuffer());
      return reply.send(buf.length > 0 ? buf : null);
    },
  });
}

// Email is parsed only to derive a keyed digest for the limiter bucket —
// never logged, never used as a metrics label, never stored raw.
function extractLoginEmailKey(body: Buffer | undefined): string | undefined {
  try {
    const parsed = body ? (JSON.parse(body.toString('utf8')) as { email?: unknown }) : undefined;
    if (typeof parsed?.email === 'string' && parsed.email.length > 0) {
      return normalizedEmailDigest(env.BETTER_AUTH_SECRET, parsed.email);
    }
  } catch {
    // Malformed body — Better Auth's own handler will reject it; the IP
    // check still applies.
  }
  return undefined;
}

function checkLoginRateLimit(
  request: FastifyRequest,
  emailKey: string | undefined,
  ipLimiter: RateLimiter,
  emailLimiter: RateLimiter,
): { allowed: boolean; retryAfterSeconds: number } {
  const ipDecision = ipLimiter.check(request.ip);
  if (!ipDecision.allowed) return ipDecision;
  if (!emailKey) return { allowed: true, retryAfterSeconds: 0 };
  return emailLimiter.check(emailKey);
}
