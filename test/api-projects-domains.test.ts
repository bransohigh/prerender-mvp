import { describe, expect, it, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createFakeRepoSet } from './helpers/fake-repos.js';
import type { RenderFn } from '../src/types/render.js';

// Functional project/domain management now lives entirely under
// organization-scoped routes (test/db/tenancy-*.test.ts, real Postgres) —
// this file only pins the legacy-endpoint migration contract: every old
// unscoped management route is permanently 410, and ADMIN_API_KEY does not
// restore access to any of them.
const ADMIN_API_KEY = process.env['ADMIN_API_KEY']!;

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

const MIGRATED_ENDPOINTS: Array<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string }> = [
  { method: 'POST', url: '/v1/projects' },
  { method: 'GET', url: '/v1/projects' },
  { method: 'GET', url: '/v1/projects/00000000-0000-0000-0000-000000000000' },
  { method: 'PATCH', url: '/v1/projects/00000000-0000-0000-0000-000000000000' },
  { method: 'DELETE', url: '/v1/projects/00000000-0000-0000-0000-000000000000' },
  { method: 'POST', url: '/v1/projects/00000000-0000-0000-0000-000000000000/domains' },
  { method: 'GET', url: '/v1/projects/00000000-0000-0000-0000-000000000000/domains' },
  { method: 'GET', url: '/v1/domains/00000000-0000-0000-0000-000000000000' },
  { method: 'POST', url: '/v1/domains/00000000-0000-0000-0000-000000000000/rotate-verification-token' },
  { method: 'POST', url: '/v1/domains/00000000-0000-0000-0000-000000000000/verify' },
  { method: 'POST', url: '/v1/domains/00000000-0000-0000-0000-000000000000/discover-sitemaps' },
  { method: 'POST', url: '/v1/sitemap-sources/00000000-0000-0000-0000-000000000000/fetch' },
];

describe('legacy unscoped management endpoints (410 Gone)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  afterEach(async () => {
    await app?.close();
  });

  for (const endpoint of MIGRATED_ENDPOINTS) {
    it(`${endpoint.method} ${endpoint.url} returns 410 ENDPOINT_MIGRATED without any credential`, async () => {
      app = await buildTestApp();
      const res = await app.inject({ method: endpoint.method, url: endpoint.url });
      expect(res.statusCode).toBe(410);
      expect(res.json().error).toBe('ENDPOINT_MIGRATED');
    });

    it(`${endpoint.method} ${endpoint.url} returns 410 even with a valid ADMIN_API_KEY`, async () => {
      app = await buildTestApp();
      const res = await app.inject({
        method: endpoint.method,
        url: endpoint.url,
        headers: { 'x-admin-api-key': ADMIN_API_KEY },
      });
      expect(res.statusCode).toBe(410);
      expect(res.json().error).toBe('ENDPOINT_MIGRATED');
    });
  }

  it('does not expose tenant data in the 410 response body', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/v1/projects' });
    expect(res.statusCode).toBe(410);
    const body = res.json();
    expect(body).not.toHaveProperty('items');
    expect(body).not.toHaveProperty('organizationId');
  });
});
