import { describe, expect, it, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createMetrics } from '../src/lib/metrics.js';
import { createFakeRepoSet, seedVerifiedDomain } from './helpers/fake-repos.js';
import type { RenderFn } from '../src/types/render.js';

const RENDER_API_KEY = process.env['RENDER_API_KEY']!;

function makeFakeRenderUrl(): RenderFn {
  return vi.fn<RenderFn>().mockResolvedValue({
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    statusCode: 200,
    title: 'Example',
    html: '<html><head><title>Example</title></head><body>Hello</body></html>',
    renderTimeMs: 42,
    renderedAt: new Date().toISOString(),
  });
}

async function buildTestApp(
  renderUrl: RenderFn,
  extra: Record<string, unknown> = {},
): Promise<{ app: Awaited<ReturnType<typeof buildApp>>; domainId: string }> {
  const repos = createFakeRepoSet();
  const domain = await seedVerifiedDomain(repos.domainRepository, 'example.com');
  const app = await buildApp({
    renderUrl,
    ...repos,
    checkDatabaseReady: async () => true,
    ...extra,
  });
  return { app, domainId: domain.id };
}

describe('GET /metrics', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  afterEach(async () => {
    await app?.close();
  });

  it('returns Prometheus content type', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('sets cache-control: no-store', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('does not require an API key', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
  });

  it('reflects render results recorded via the injected metrics instance', async () => {
    const metrics = createMetrics();
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl(), { metrics }));

    await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { domainId, url: 'https://example.com' },
    });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.payload).toMatch(/prerender_render_requests_total\{result="success"\} 1/);
  });

  it('never contains the API key in output', async () => {
    const metrics = createMetrics();
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl(), { metrics }));

    await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { domainId, url: 'https://example.com' },
    });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.payload).not.toContain(RENDER_API_KEY);
  });

  it('never contains a raw URL or query string in output', async () => {
    const metrics = createMetrics();
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl(), { metrics }));

    await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { domainId, url: 'https://example.com/secret-path?token=abc123' },
    });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.payload).not.toContain('secret-path');
    expect(res.payload).not.toContain('token=abc123');
  });
});

describe('GET /livez', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  afterEach(async () => {
    await app?.close();
  });

  it('200 ve status ok döner', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({ method: 'GET', url: '/livez' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ status: 'ok' });
  });
});

describe('GET /readyz', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  afterEach(async () => {
    await app?.close();
  });

  it('kapasite açık ve database hazırken 200 döner', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ status: 'ready' });
  });

  it('shutdown başladığında 503 döner', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl()));
    app.markShuttingDown();
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.payload)).toEqual({ status: 'not_ready' });
  });

  it('database hazır değilken 503 döner', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl(), { checkDatabaseReady: async () => false }));
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.payload)).toEqual({ status: 'not_ready' });
  });
});

describe('GET /health (backward compatibility)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  afterEach(async () => {
    await app?.close();
  });

  it('200 ve status ok döner', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { status: string };
    expect(body.status).toBe('ok');
  });
});

describe('x-request-id', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  afterEach(async () => {
    await app?.close();
  });

  it('response içinde x-request-id header bulunur', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({ method: 'GET', url: '/livez' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('geçerli client-supplied request id kabul edilir', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'GET',
      url: '/livez',
      headers: { 'x-request-id': 'my-safe-id-123' },
    });
    expect(res.headers['x-request-id']).toBe('my-safe-id-123');
  });

  it('tehlikeli/uzun client-supplied request id reddedilir ve yenisi üretilir', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl()));
    const malicious = 'a'.repeat(500);
    const res = await app.inject({
      method: 'GET',
      url: '/livez',
      headers: { 'x-request-id': malicious },
    });
    expect(res.headers['x-request-id']).not.toBe(malicious);
  });

  it('error response içinde requestId bulunur', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { domainId },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { requestId: string };
    expect(body.requestId).toBeTruthy();
    expect(body.requestId).toBe(res.headers['x-request-id']);
  });
});

describe('güvenli loglama', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  afterEach(async () => {
    await app?.close();
  });

  it('API key response payload içinde görünmez', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.payload).not.toContain(RENDER_API_KEY);
  });

  it('query string içeren URL sonucu yanıtta query değeri geri döner ama loglanan origin path/query içermez', async () => {
    const { safeUrlOrigin } = await import('../src/lib/url-security.js');
    const origin = safeUrlOrigin('https://example.com/path?secret=xyz#frag');
    expect(origin).toBe('https://example.com:443');
    expect(origin).not.toContain('path');
    expect(origin).not.toContain('secret');
    expect(origin).not.toContain('frag');
  });
});
