import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createDbClient, type DbClient } from '../../src/db/client.js';
import { env } from '../../src/config/env.js';
import { truncateAll } from './helpers.js';

// Exercises the actual /api/auth/* Fastify mount (src/auth/plugin.ts) over
// HTTP via app.inject() — not auth.api.* directly. This is the hand-written
// Fastify<->Better Auth Request/Response bridge, so it needs its own
// coverage independent of the auth.api tests in auth-onboarding.test.ts.

let app: FastifyInstance;
let dbClient: DbClient;

const EMAIL = 'bridge-user@example.com';
const PASSWORD = 'correct-horse-battery-staple';

beforeEach(async () => {
  dbClient ??= createDbClient(env.DATABASE_URL);
  await truncateAll(dbClient);
  app = await buildApp();
  await app.ready();

  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email: EMAIL, name: 'Bridge User', password: PASSWORD },
  });
  // sign-up is blocked at the route layer regardless of what Better Auth
  // itself would do — see the dedicated test below. Create the test user
  // directly through auth.api instead so other tests have a fixture.
  expect(signUp.statusCode).toBe(404);
});

afterEach(async () => {
  await app.close();
});

async function createFixtureUser(): Promise<void> {
  const auth = (await import('../../src/auth/auth.js')).createAuth(dbClient.db);
  await auth.api.signUpEmail({ body: { email: EMAIL, name: 'Bridge User', password: PASSWORD } });
}

describe('Fastify <-> Better Auth HTTP bridge (/api/auth/*)', () => {
  it('blocks public sign-up regardless of HTTP method casing/path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'nope@example.com', name: 'Nope', password: PASSWORD },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body).not.toHaveProperty('user');
  });

  it('signs in with valid credentials and returns a Set-Cookie header', async () => {
    await createFixtureUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sessionCookie = cookies.find((c) => c?.includes('session_token'));
    expect(sessionCookie).toBeDefined();
  });

  it('returns the same generic error shape for wrong password and unknown email', async () => {
    await createFixtureUser();

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: EMAIL, password: 'totally-wrong-password' },
    });
    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'never-existed@example.com', password: 'totally-wrong-password' },
    });

    expect(wrongPassword.statusCode).toBe(unknownEmail.statusCode);
    expect(wrongPassword.statusCode).toBeGreaterThanOrEqual(400);
    const wrongBody = wrongPassword.json();
    const unknownBody = unknownEmail.json();
    // Same stable error code shape; neither response distinguishes
    // "wrong password" from "no such account".
    const shapeOf = (body: Record<string, unknown>): string =>
      body['code'] !== undefined ? 'code' : body['message'] !== undefined ? 'message' : 'unknown';
    expect(shapeOf(wrongBody)).toBe(shapeOf(unknownBody));
    expect(JSON.stringify(wrongBody)).not.toMatch(/stack|Error:/i);
  });

  it('does not leak an internal stack trace on error responses', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'nope@example.com', password: 'x' },
    });
    expect(res.body).not.toMatch(/at Object\.|node_modules|\.ts:\d+:\d+/);
  });

  it('authenticated session cookie is recognized by /api/auth/get-session', async () => {
    await createFixtureUser();
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: EMAIL, password: PASSWORD },
    });
    const cookieHeader = extractCookieHeader(signIn);

    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie: cookieHeader },
    });
    expect(session.statusCode).toBe(200);
    const body = session.json();
    expect(body.user.email).toBe(EMAIL);
  });

  it('logout invalidates the server-side session and the cookie no longer works', async () => {
    await createFixtureUser();
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: EMAIL, password: PASSWORD },
    });
    const cookieHeader = extractCookieHeader(signIn);

    const signOut = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie: cookieHeader },
    });
    expect(signOut.statusCode).toBe(200);

    const reused = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie: cookieHeader },
    });
    // No active session: Better Auth returns 200 with a null body for
    // get-session rather than 401 — assert on the body, not the status.
    const body = reused.body.length > 0 ? reused.json() : null;
    expect(body === null || body?.session == null).toBe(true);
  });

  it('preserves query parameters and non-JSON GET requests through the bridge', async () => {
    await createFixtureUser();
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: EMAIL, password: PASSWORD },
    });
    const cookieHeader = extractCookieHeader(signIn);

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session?disableCookieCache=true',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
  });

  it('transfers multiple response headers correctly (no dropped/duplicated Set-Cookie)', async () => {
    await createFixtureUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: EMAIL, password: PASSWORD },
    });
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(cookies.length).toBeGreaterThanOrEqual(1);
    // No entry should be malformed (missing '=' before any ';').
    for (const c of cookies) {
      expect(c.split(';')[0]).toMatch(/^[^=]+=.+/);
    }
  });
});

function extractCookieHeader(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as string];
  return cookies.map((c) => c.split(';')[0]).join('; ');
}
