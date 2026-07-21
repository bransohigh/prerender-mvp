import { describe, expect, it, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
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

function makeFakeRenderUrlError(message: string): RenderFn {
  return vi.fn<RenderFn>().mockRejectedValue(new Error(message));
}

async function buildTestApp(renderUrl: RenderFn) {
  const repos = createFakeRepoSet();
  const domain = await seedVerifiedDomain(repos.domainRepository, 'example.com');
  const app = await buildApp({ renderUrl, ...repos });
  return { app, domainId: domain.id };
}

describe('GET /health', () => {
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

describe('POST /v1/render', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  afterEach(async () => {
    await app?.close();
  });

  it('API key olmadan 401 döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('yanlış API key ile 401 döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': 'wrong-key-wrong-key-wrong-key-32c' },
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('eski x-api-key header artık kabul edilmez', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-api-key': RENDER_API_KEY },
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('url alanı olmadan 400 döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { domainId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('domainId alanı olmadan 400 döner', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('geçersiz URL ile 400 döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { domainId, url: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('bilinmeyen domainId ile 404 döner', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { domainId: '00000000-0000-0000-0000-000000000000', url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.payload) as { error: string };
    expect(body.error).toBe('DOMAIN_NOT_FOUND');
  });

  it('doğrulanmamış domain ile 409 döner', async () => {
    const repos = createFakeRepoSet();
    const unverified = await repos.domainRepository.create({
      projectId: 'proj-1',
      hostname: 'unverified.example.com',
      normalizedHostname: 'unverified.example.com',
      verificationMethod: 'dns_txt',
      verificationTokenHash: 'hash',
    });
    app = await buildApp({ renderUrl: makeFakeRenderUrl(), ...repos });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { domainId: unverified.id, url: 'https://unverified.example.com' },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload) as { error: string };
    expect(body.error).toBe('DOMAIN_NOT_VERIFIED');
  });

  it('domain hostname eşleşmeyen URL ile 400 döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { domainId, url: 'https://not-example.com/' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error: string };
    expect(body.error).toBe('URL_DOMAIN_MISMATCH');
  });

  it('geçerli istek ile response şeması doğru', async () => {
    const fakeRender = makeFakeRenderUrl();
    let domainId: string;
    ({ app, domainId } = await buildTestApp(fakeRender));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as Record<string, unknown>;
    expect(body).toHaveProperty('url');
    expect(body).toHaveProperty('finalUrl');
    expect(body).toHaveProperty('statusCode');
    expect(body).toHaveProperty('title');
    expect(body).toHaveProperty('html');
    expect(body).toHaveProperty('renderTimeMs');
    expect(body).toHaveProperty('renderedAt');
  });

  it('renderer hatası 422 döner ve stack trace sızdırmaz', async () => {
    const fakeRender = makeFakeRenderUrlError('Render hatası oluştu');
    let domainId: string;
    ({ app, domainId } = await buildTestApp(fakeRender));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload) as { error: string };
    expect(body.error).toBe('Render hatası oluştu');
    expect(res.payload).not.toContain('at ');
    expect(res.payload).not.toContain('node_modules');
  });

  it('renderer yalnızca doğrulama sonrası çağrılır', async () => {
    const fakeRender = makeFakeRenderUrl();
    let domainId: string;
    ({ app, domainId } = await buildTestApp(fakeRender));

    // invalid body — renderer should not be called
    await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { domainId },
    });
    expect(fakeRender).not.toHaveBeenCalled();

    // missing api key — renderer should not be called
    await app.inject({
      method: 'POST',
      url: '/v1/render',
      payload: { domainId, url: 'https://example.com' },
    });
    expect(fakeRender).not.toHaveBeenCalled();
  });

  it('hatalı body ile error detayı döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': RENDER_API_KEY },
      payload: { domainId, url: 123 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error: string; details: unknown };
    expect(body.error).toBe('Geçersiz istek');
    expect(body.details).toBeDefined();
  });
});
