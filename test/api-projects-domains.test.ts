import { describe, expect, it, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createFakeRepoSet } from './helpers/fake-repos.js';
import type { RenderFn } from '../src/types/render.js';

const ADMIN_API_KEY = process.env['ADMIN_API_KEY']!;
const RENDER_API_KEY = process.env['RENDER_API_KEY']!;

function makeFakeRenderUrl(): RenderFn {
  return vi.fn<RenderFn>().mockResolvedValue({
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    statusCode: 200,
    title: 'Example',
    html: '<html></html>',
    renderTimeMs: 1,
    renderedAt: new Date().toISOString(),
  });
}

async function buildTestApp() {
  const repos = createFakeRepoSet();
  const app = await buildApp({
    renderUrl: makeFakeRenderUrl(),
    ...repos,
    checkDatabaseReady: async () => true,
  });
  return app;
}

describe('Admin API authentication', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  afterEach(async () => {
    await app?.close();
  });

  it('POST /v1/projects without admin key returns 401', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/v1/projects', payload: { name: 'A' } });
    expect(res.statusCode).toBe(401);
  });

  it('render API key does not authenticate admin endpoints', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { name: 'A' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/projects', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  afterEach(async () => {
    await app?.close();
  });

  it('creates a project and returns 201', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
      payload: { name: 'Example Project', slug: 'example-project' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload) as { id: string; slug: string };
    expect(body.slug).toBe('example-project');
    expect(body.id).toBeTruthy();
  });

  it('derives a slug when none provided', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
      payload: { name: 'Example Project' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload) as { slug: string };
    expect(body.slug).toBe('example-project');
  });
});

describe('GET /v1/projects pagination', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  afterEach(async () => {
    await app?.close();
  });

  it('respects the limit and returns nextCursor', async () => {
    app = await buildTestApp();
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { 'x-admin-api-key': ADMIN_API_KEY },
        payload: { name: `P${i}`, slug: `p${i}` },
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects?limit=2',
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeTruthy();
  });

  it('rejects a limit above the maximum', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects?limit=1000',
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET/PATCH/DELETE /v1/projects/:id', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  afterEach(async () => {
    await app?.close();
  });

  it('404 for unknown project', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects/00000000-0000-0000-0000-000000000000',
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH updates allowed fields', async () => {
    app = await buildTestApp();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
      payload: { name: 'A', slug: 'a' },
    });
    const { id } = JSON.parse(created.payload) as { id: string };

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${id}`,
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
      payload: { name: 'B' },
    });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.payload) as { name: string }).name).toBe('B');
  });

  it('DELETE soft-deletes (status=deleted), not hard delete', async () => {
    app = await buildTestApp();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
      payload: { name: 'A', slug: 'a' },
    });
    const { id } = JSON.parse(created.payload) as { id: string };

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${id}`,
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
    });
    expect(del.statusCode).toBe(204);

    const getAfter = await app.inject({
      method: 'GET',
      url: `/v1/projects/${id}`,
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
    });
    expect(getAfter.statusCode).toBe(404); // service treats deleted as not-found
  });
});

describe('Domain endpoints', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  afterEach(async () => {
    await app?.close();
  });

  async function createProject(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
      payload: { name: 'A', slug: 'a' },
    });
    return (JSON.parse(res.payload) as { id: string }).id;
  }

  it('POST creates a domain and shows the token exactly once', async () => {
    app = await buildTestApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/domains`,
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
      payload: { hostname: 'www.example.com', verificationMethod: 'dns_txt' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload) as {
      domain: { status: string };
      verification: { token: string; recordName: string; recordValue: string };
    };
    expect(body.domain.status).toBe('pending');
    expect(body.verification.token).toMatch(/^[a-f0-9]{64}$/);
    expect(body.verification.recordName).toBe('_prerender-verification.www.example.com');
  });

  it('GET list never includes the token or hash', async () => {
    app = await buildTestApp();
    const projectId = await createProject(app);
    await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/domains`,
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
      payload: { hostname: 'www.example.com', verificationMethod: 'dns_txt' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/domains`,
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
    });
    expect(res.payload).not.toContain('verificationTokenHash');
    expect(res.payload).not.toContain('token');
  });

  it('GET /v1/domains/:id never includes the token or hash', async () => {
    app = await buildTestApp();
    const projectId = await createProject(app);
    const created = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/domains`,
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
      payload: { hostname: 'www.example.com', verificationMethod: 'dns_txt' },
    });
    const { domain } = JSON.parse(created.payload) as { domain: { id: string } };

    const res = await app.inject({
      method: 'GET',
      url: `/v1/domains/${domain.id}`,
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
    });
    expect(res.payload).not.toContain('verificationTokenHash');
  });

  it('discover-sitemaps on an unverified domain is rejected', async () => {
    app = await buildTestApp();
    const projectId = await createProject(app);
    const created = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/domains`,
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
      payload: { hostname: 'www.example.com', verificationMethod: 'dns_txt' },
    });
    const { domain } = JSON.parse(created.payload) as { domain: { id: string } };

    const res = await app.inject({
      method: 'POST',
      url: `/v1/domains/${domain.id}/discover-sitemaps`,
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload) as { error: string };
    expect(body.error).toBe('DOMAIN_NOT_VERIFIED');
  });

  it('rejects invalid hostname with 400', async () => {
    app = await buildTestApp();
    const projectId = await createProject(app);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/domains`,
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
      payload: { hostname: 'localhost', verificationMethod: 'dns_txt' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error: string };
    expect(body.error).toBe('INVALID_DOMAIN');
  });
});
