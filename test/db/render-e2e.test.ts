import http from 'node:http';
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createDbClient, type DbClient } from '../../src/db/client.js';
import { env } from '../../src/config/env.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { truncateAll } from './helpers.js';
import { member as memberTable, domains, apikey as apikeyTable } from '../../src/db/schema.js';
import { createRenderer } from '../../src/services/renderer.js';
import type { Renderer } from '../../src/services/renderer.js';
import type { UrlValidator } from '../../src/types/render.js';

// Real Postgres + real Chromium, through the actual POST /v1/render HTTP
// route with a genuine project-scoped API key. The route's own domain
// authorization (src/lib/url-normalize.ts) hard-requires HTTPS + port 443
// + an exact hostname match against a *verified* domain — a local
// ephemeral fixture server can't satisfy that directly, so (matching the
// existing pattern in test/integration/e2e.test.ts) we inject a test-only
// UrlValidator that only ever accepts the exact fixture origin
// (https://render-e2e-fixture.example.com) and rewrites it to the local
// server's real address for the actual Chromium navigation. This is not a
// production SSRF bypass: the validator is injected only in this test
// process, rejects every other origin, and production still uses
// assertSafePublicUrl (real DNS/private-IP checks) unmodified.

const FIXTURE_HOSTNAME = 'render-e2e-fixture.example.com';
const FIXTURE_ORIGIN = `https://${FIXTURE_HOSTNAME}`;

let testServer: http.Server;
let testOrigin: string;
let renderer: Renderer;

// Called twice per navigation: once by renderer.ts's renderUrl() with the
// original logical URL (to compute the navigation target), and again by
// its per-request context.route() handler with the *actual* URL Chromium
// is requesting (which is already the rewritten local address, for the
// main document and every subresource). Both call shapes must be
// accepted; anything that is neither the exact fixture origin nor the
// exact real local origin is rejected — this is what keeps the rewrite
// from being a general-purpose SSRF bypass.
function createFixtureRestrictedValidator(realOrigin: string): UrlValidator {
  return async (rawUrl: string): Promise<URL> => {
    const parsed = new URL(rawUrl);
    if (parsed.origin === realOrigin) {
      return parsed;
    }
    if (parsed.origin !== FIXTURE_ORIGIN) {
      throw new Error(`Test validator: only ${FIXTURE_ORIGIN} or ${realOrigin} is allowed, got ${parsed.origin}`);
    }
    const real = new URL(realOrigin);
    real.pathname = parsed.pathname;
    real.search = parsed.search;
    return real;
  };
}

beforeAll(async () => {
  testServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>Loading</title></head><body>
      <p id="content">Initial</p>
      <script>
        document.title = 'Render E2E';
        document.getElementById('content').textContent = 'Rendered by Chromium';
      </script>
    </body></html>`);
  });
  await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', resolve));
  const address = testServer.address();
  if (!address || typeof address === 'string') throw new Error('failed to start test server');
  testOrigin = `http://127.0.0.1:${address.port}`;
  renderer = createRenderer({ urlValidator: createFixtureRestrictedValidator(testOrigin) });
});

afterAll(async () => {
  await renderer.close();
  await new Promise<void>((resolve) => testServer.close(() => resolve()));
});

let dbClient: DbClient;
let auth: Auth;
let app: FastifyInstance;

const TRUSTED_ORIGIN = env.AUTH_TRUSTED_ORIGINS[0]!;
const PASSWORD = 'correct-horse-battery-staple';

beforeEach(async () => {
  dbClient ??= createDbClient(env.DATABASE_URL);
  auth ??= createAuth(dbClient.db);
  await truncateAll(dbClient);
  app = await buildApp({ renderUrl: renderer.renderUrl });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function loginCookie(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email, password } });
  const setCookie = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as string];
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

async function setup(label: string) {
  const email = `owner-${label}@example.com`;
  const signUp = await auth.api.signUpEmail({ body: { email, name: `Owner ${label}`, password: PASSWORD } });
  const org = await auth.api.createOrganization({ body: { name: `Org ${label}`, slug: `e2e-org-${label}-${Date.now()}`, userId: signUp.user.id } });
  if (!org) throw new Error('org create failed');
  const existing = await dbClient.db.query.member.findFirst({ where: and(eq(memberTable.organizationId, org.id), eq(memberTable.userId, signUp.user.id)) });
  if (existing) {
    await dbClient.db.update(memberTable).set({ role: 'owner' }).where(eq(memberTable.id, existing.id));
  } else {
    await dbClient.db.insert(memberTable).values({ id: `mem_${signUp.user.id}_${org.id}`, organizationId: org.id, userId: signUp.user.id, role: 'owner', createdAt: new Date() });
  }
  const cookie = await loginCookie(email, PASSWORD);

  const projectRes = await app.inject({ method: 'POST', url: `/v1/organizations/${org.id}/projects`, headers: { cookie, origin: TRUSTED_ORIGIN }, payload: { name: `P ${label}` } });
  const project = projectRes.json() as { id: string };

  const domainRes = await app.inject({
    method: 'POST',
    url: `/v1/organizations/${org.id}/projects/${project.id}/domains`,
    headers: { cookie, origin: TRUSTED_ORIGIN },
    payload: { hostname: FIXTURE_HOSTNAME, verificationMethod: 'dns_txt' },
  });
  const domain = (domainRes.json() as { domain: { id: string } }).domain;
  await dbClient.db.update(domains).set({ status: 'verified', verifiedAt: new Date() }).where(eq(domains.id, domain.id));

  const keyRes = await app.inject({
    method: 'POST',
    url: `/v1/organizations/${org.id}/projects/${project.id}/api-keys`,
    headers: { cookie, origin: TRUSTED_ORIGIN },
    payload: { name: 'E2E Key' },
  });
  const key = keyRes.json() as { id: string; key: string };

  return { organizationId: org.id, cookie, project, domainId: domain.id, key };
}

describe('render E2E: real Postgres + real Chromium + project-scoped API key', () => {
  it('renders real JavaScript-produced HTML, records metrics, updates lastUsed, and returns capacity to idle', async () => {
    const fx = await setup('full');

    const before = await dbClient.db.select().from(apikeyTable).where(eq(apikeyTable.id, fx.key.id)).then((r) => r[0]);
    expect(before?.lastRequest).toBeNull();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': fx.key.key },
      payload: { domainId: fx.domainId, url: `${FIXTURE_ORIGIN}/dynamic` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { html: string; title: string };
    expect(body.title).toBe('Render E2E');
    expect(body.html).toContain('Rendered by Chromium');

    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.body).toMatch(/prerender_render_requests_total\{result="success"\} 1/);
    expect(metricsRes.body).toMatch(/prerender_render_active 0/);
    expect(metricsRes.body).toMatch(/prerender_render_queued 0/);

    const after = await dbClient.db.select().from(apikeyTable).where(eq(apikeyTable.id, fx.key.id)).then((r) => r[0]);
    expect(after?.lastRequest).not.toBeNull();
  }, 30000);

  it('a key from another project is rejected before Chromium starts', async () => {
    const fx = await setup('other-project');
    const otherProjectRes = await app.inject({ method: 'POST', url: `/v1/organizations/${fx.organizationId}/projects`, headers: { cookie: fx.cookie, origin: TRUSTED_ORIGIN }, payload: { name: 'Other' } });
    const otherProject = otherProjectRes.json() as { id: string };
    const otherKeyRes = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${fx.organizationId}/projects/${otherProject.id}/api-keys`,
      headers: { cookie: fx.cookie, origin: TRUSTED_ORIGIN },
      payload: { name: 'Other Key' },
    });
    const otherKey = otherKeyRes.json() as { key: string };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': otherKey.key },
      payload: { domainId: fx.domainId, url: `${FIXTURE_ORIGIN}/dynamic` },
    });
    expect(res.statusCode).toBe(404);
  }, 30000);

  it('a revoked key is rejected before Chromium starts', async () => {
    const fx = await setup('revoked');
    await app.inject({ method: 'DELETE', url: `/v1/organizations/${fx.organizationId}/projects/${fx.project.id}/api-keys/${fx.key.id}`, headers: { cookie: fx.cookie, origin: TRUSTED_ORIGIN } });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': fx.key.key },
      payload: { domainId: fx.domainId, url: `${FIXTURE_ORIGIN}/dynamic` },
    });
    expect(res.statusCode).toBe(401);
  }, 30000);
});

