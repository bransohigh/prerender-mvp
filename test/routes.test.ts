import { describe, expect, it, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { RenderFn } from '../src/types/render.js';

const VALID_API_KEY = process.env['API_KEY'] ?? 'test-api-key-12345';

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

describe('GET /health', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  afterEach(async () => {
    await app?.close();
  });

  it('200 ve status ok döner', async () => {
    app = await buildApp({ renderUrl: makeFakeRenderUrl() });
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
    app = await buildApp({ renderUrl: makeFakeRenderUrl() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      payload: { url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('yanlış API key ile 401 döner', async () => {
    app = await buildApp({ renderUrl: makeFakeRenderUrl() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-api-key': 'wrong-key-wrong-key' },
      payload: { url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('url alanı olmadan 400 döner', async () => {
    app = await buildApp({ renderUrl: makeFakeRenderUrl() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-api-key': VALID_API_KEY },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('geçersiz URL ile 400 döner', async () => {
    app = await buildApp({ renderUrl: makeFakeRenderUrl() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-api-key': VALID_API_KEY },
      payload: { url: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('geçerli istek ile response şeması doğru', async () => {
    const fakeRender = makeFakeRenderUrl();
    app = await buildApp({ renderUrl: fakeRender });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-api-key': VALID_API_KEY },
      payload: { url: 'https://example.com' },
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
    app = await buildApp({ renderUrl: fakeRender });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-api-key': VALID_API_KEY },
      payload: { url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload) as { error: string };
    expect(body.error).toBe('Render hatası oluştu');
    expect(res.payload).not.toContain('at ');
    expect(res.payload).not.toContain('node_modules');
  });

  it('renderer yalnızca doğrulama sonrası çağrılır', async () => {
    const fakeRender = makeFakeRenderUrl();
    app = await buildApp({ renderUrl: fakeRender });

    // invalid body — renderer should not be called
    await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-api-key': VALID_API_KEY },
      payload: {},
    });
    expect(fakeRender).not.toHaveBeenCalled();

    // missing api key — renderer should not be called
    await app.inject({
      method: 'POST',
      url: '/v1/render',
      payload: { url: 'https://example.com' },
    });
    expect(fakeRender).not.toHaveBeenCalled();
  });

  it('hatalı body ile error detayı döner', async () => {
    app = await buildApp({ renderUrl: makeFakeRenderUrl() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-api-key': VALID_API_KEY },
      payload: { url: 123 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error: string; details: unknown };
    expect(body.error).toBe('Geçersiz istek');
    expect(body.details).toBeDefined();
  });
});
