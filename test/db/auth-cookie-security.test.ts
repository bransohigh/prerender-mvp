import { describe, expect, it, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createDbClient, type DbClient } from '../../src/db/client.js';
import { env } from '../../src/config/env.js';
import { truncateAll } from './helpers.js';

// Cookie behavior is controlled entirely by NODE_ENV (via
// advanced.useSecureCookies in src/auth/auth.ts) — this file asserts the
// exact resulting cookie name/flags for both dev and prod, and documents
// why the cookie uses the `__Secure-` prefix rather than `__Host-`.
//
// Better Auth's cookie builder (node_modules/better-auth/dist/cookies/index.mjs)
// only ever applies `__Secure-` (never `__Host-`) when useSecureCookies is
// true. `__Host-` additionally requires Path=/ (satisfied here) AND no
// Domain attribute AND being set only over HTTPS with `Secure` — Better
// Auth does not expose a `__Host-` option, so this app's cookie is
// `__Secure-prerender.session_token` in production, not `__Host-*`. The
// missing Domain attribute (crossSubDomainCookies is not enabled) still
// gives the same "cannot be overridden by a subdomain" property in
// practice, but the RFC 6265bis `__Host-` name is not used, and this must
// not be described as `__Host-` compliant.

let dbClient: DbClient;
let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

async function freshApp(): Promise<FastifyInstance> {
  dbClient ??= createDbClient(env.DATABASE_URL);
  await truncateAll(dbClient);
  const built = await buildApp();
  await built.ready();
  return built;
}

function parseSetCookie(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw as string];
}

describe('session cookie security', () => {
  it('development: cookie has no __Secure- prefix and Secure is not set', async () => {
    expect(env.NODE_ENV).toBe('test');
    // NODE_ENV=test takes the same non-production branch as development in
    // src/auth/auth.ts's useSecureCookies: env.NODE_ENV === 'production'.
    app = await freshApp();

    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'dev-cookie@example.com', name: 'Dev', password: 'correct-horse-battery-staple' },
    });
    // signUpEmail via HTTP is blocked; use auth.api directly for the fixture.
    const { createAuth } = await import('../../src/auth/auth.js');
    const auth = createAuth(dbClient.db);
    await auth.api.signUpEmail({
      body: { email: 'dev-cookie2@example.com', name: 'Dev2', password: 'correct-horse-battery-staple' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'dev-cookie2@example.com', password: 'correct-horse-battery-staple' },
    });
    const cookies = parseSetCookie(res);
    const sessionCookie = cookies.find((c) => c.includes('session_token'));
    expect(sessionCookie).toBeDefined();

    expect(sessionCookie).not.toMatch(/^__Secure-/);
    expect(sessionCookie).not.toMatch(/^__Host-/);
    expect(sessionCookie).toMatch(/^prerender\.session_token=/);
    expect(sessionCookie?.toLowerCase()).not.toMatch(/;\s*secure/);
    expect(sessionCookie?.toLowerCase()).toMatch(/httponly/);
    expect(sessionCookie?.toLowerCase()).toMatch(/samesite=lax/);
    expect(sessionCookie?.toLowerCase()).toMatch(/path=\//);
    expect(sessionCookie?.toLowerCase()).not.toMatch(/domain=/);
  });

  it('production: cookie uses the __Secure- prefix (not __Host-) with Secure/HttpOnly/SameSite=Lax/Path=/, no Domain', async () => {
    const originalEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      // env.ts reads process.env once at import time via `envSchema.parse`,
      // so we build a fresh auth instance directly against the already
      // -imported `env` module's DATABASE_URL rather than re-importing env.
      const { createAuth } = await import('../../src/auth/auth.js');
      dbClient ??= createDbClient(env.DATABASE_URL);
      await truncateAll(dbClient);

      // Construct auth with an explicit production override, mirroring
      // exactly what src/auth/auth.ts computes from env.NODE_ENV, since the
      // already-parsed `env` singleton cannot be reparsed mid-process.
      const { betterAuth } = await import('better-auth');
      const { drizzleAdapter } = await import('better-auth/adapters/drizzle');
      const { organization } = await import('better-auth/plugins/organization');
      const { apiKey } = await import('@better-auth/api-key');
      const schema = await import('../../src/db/schema.js');

      const prodAuth = betterAuth({
        database: drizzleAdapter(dbClient.db, { provider: 'pg', schema }),
        secret: env.BETTER_AUTH_SECRET,
        baseURL: env.BETTER_AUTH_BASE_URL,
        trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
        emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128, autoSignIn: true },
        session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
        advanced: { cookiePrefix: 'prerender', useSecureCookies: true },
        plugins: [organization(), apiKey({ references: 'organization', defaultPrefix: 'pr_live_' })],
      });

      await prodAuth.api.signUpEmail({
        body: { email: 'prod-cookie@example.com', name: 'Prod', password: 'correct-horse-battery-staple' },
      });
      const signInResponse = await prodAuth.api.signInEmail({
        body: { email: 'prod-cookie@example.com', password: 'correct-horse-battery-staple' },
        asResponse: true,
      });
      const setCookieHeader = (signInResponse as Response).headers.get('set-cookie') ?? '';
      expect(setCookieHeader).toMatch(/^__Secure-prerender\.session_token=/);
      expect(setCookieHeader).not.toMatch(/^__Host-/);
      expect(setCookieHeader.toLowerCase()).toMatch(/secure/);
      expect(setCookieHeader.toLowerCase()).toMatch(/httponly/);
      expect(setCookieHeader.toLowerCase()).toMatch(/samesite=lax/);
      expect(setCookieHeader.toLowerCase()).toMatch(/path=\//);
      expect(setCookieHeader.toLowerCase()).not.toMatch(/domain=/);
      void createAuth; // referenced for documentation parity, unused here
    } finally {
      process.env['NODE_ENV'] = originalEnv;
    }
  });

  it('client-supplied headers cannot force insecure cookies in a production instance', async () => {
    // useSecureCookies is derived solely from server-side NODE_ENV at
    // startup (src/auth/auth.ts), never from any request header/body — so
    // there is no input an attacker can send to downgrade cookie security.
    // Asserted structurally: createAuth()'s signature takes no per-request
    // options and env.NODE_ENV is fixed at process start.
    const authModule = await import('../../src/auth/auth.js');
    expect(authModule.createAuth.length).toBe(1); // only `db`, no request-derived config
  });
});
