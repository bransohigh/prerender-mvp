import http from 'node:http';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createRenderer, type Renderer } from '../../src/services/renderer.js';
import type { UrlValidator } from '../../src/types/render.js';

const VALID_API_KEY = process.env['API_KEY'] ?? 'test-api-key-12345';

let testServer: http.Server;
let testOrigin: string;
let renderer: Renderer;
let app: Awaited<ReturnType<typeof buildApp>>;

function createTestValidator(allowedOrigin: string): UrlValidator {
  return async (rawUrl: string): Promise<URL> => {
    const parsed = new URL(rawUrl);
    if (parsed.origin !== allowedOrigin) {
      throw new Error(`Test validator: ${parsed.origin} is not allowed (only ${allowedOrigin})`);
    }
    return parsed;
  };
}

function createTestServer(): Promise<{ server: http.Server; origin: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';

      if (url === '/dynamic') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><head><title>Loading</title></head><body>
          <p id="content">Initial</p>
          <script>
            document.title = 'E2E Dynamic';
            document.getElementById('content').textContent = 'E2E Content';
          </script>
        </body></html>`);
        return;
      }

      if (url === '/basic') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head><title>Basic</title></head><body>OK</body></html>');
        return;
      }

      if (url === '/slow-render') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><head><title>Slow</title></head><body>
          <script>
            // Block for a bit to simulate work
            const start = Date.now();
            while (Date.now() - start < 500) {}
            document.title = 'Slow Done';
          </script>
        </body></html>`);
        return;
      }

      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><head><title>404</title></head><body>Not found</body></html>');
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve({ server, origin: `http://127.0.0.1:${addr.port}` });
      }
    });
  });
}

beforeAll(async () => {
  const result = await createTestServer();
  testServer = result.server;
  testOrigin = result.origin;

  renderer = createRenderer({
    urlValidator: createTestValidator(testOrigin),
    renderTimeoutMs: 10000,
    maxHtmlBytes: 500000,
  });
});

afterAll(async () => {
  await app?.close();
  await renderer.close();
  await new Promise<void>((resolve) => testServer.close(() => resolve()));
});

describe('E2E: Fastify → capacity → Chromium', () => {
  it('başarılı render — JS sonrası içerik doğru', async () => {
    app = await buildApp({
      renderUrl: renderer.renderUrl,
      maxConcurrentRenders: 2,
      maxQueuedRenders: 5,
      renderQueueTimeoutMs: 10000,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-api-key': VALID_API_KEY },
      payload: { url: `${testOrigin}/dynamic` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as Record<string, unknown>;
    expect(body['title']).toBe('E2E Dynamic');
    expect(body['html']).toContain('E2E Content');
    expect(body['statusCode']).toBe(200);
    expect(body['finalUrl']).toBe(`${testOrigin}/dynamic`);
    expect(body['renderTimeMs']).toBeGreaterThan(0);
  });

  it('kapasite davranışı — maxConcurrent=1, ikinci istek queued', async () => {
    await app?.close();

    // Renderer with slow responses to control timing
    const slowRenderer = createRenderer({
      urlValidator: createTestValidator(testOrigin),
      renderTimeoutMs: 10000,
      maxHtmlBytes: 500000,
    });

    app = await buildApp({
      renderUrl: slowRenderer.renderUrl,
      maxConcurrentRenders: 1,
      maxQueuedRenders: 5,
      renderQueueTimeoutMs: 10000,
    });

    // Both use /slow-render which takes ~500ms
    const p1 = app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-api-key': VALID_API_KEY },
      payload: { url: `${testOrigin}/slow-render` },
    });

    const p2 = app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-api-key': VALID_API_KEY },
      payload: { url: `${testOrigin}/basic` },
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const b1 = JSON.parse(r1.payload) as Record<string, unknown>;
    const b2 = JSON.parse(r2.payload) as Record<string, unknown>;
    expect(b1['title']).toBe('Slow Done');
    expect(b2['title']).toBe('Basic');

    await slowRenderer.close();
  });
});
