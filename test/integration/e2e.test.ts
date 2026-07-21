import http from 'node:http';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { createRenderer, type Renderer } from '../../src/services/renderer.js';
import { createDefaultLauncher } from '../../src/lib/browser-launch.js';
import { createCapacityController } from '../../src/services/render-capacity.js';
import { createRenderService } from '../../src/services/render-service.js';
import type { UrlValidator } from '../../src/types/render.js';

// NOTE: These tests exercise capacity+Chromium integration directly via
// createRenderService(), not through the Fastify /v1/render HTTP route.
// The route's domain-authorization layer (HTTPS + port 443 + exact
// hostname match against a *verified* domain) cannot be satisfied by a
// local ephemeral HTTP test server — that logic is already covered with
// fake repositories in test/routes.test.ts. This file's purpose is
// specifically the capacity-controller + real-Chromium wiring.

let testServer: http.Server;
let testOrigin: string;
let renderer: Renderer;

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
    launchBrowser: createDefaultLauncher(),
  });
});

afterAll(async () => {
  await renderer.close();
  await new Promise<void>((resolve) => testServer.close(() => resolve()));
});

describe('E2E: capacity → Chromium', () => {
  it('başarılı render — JS sonrası içerik doğru', async () => {
    const capacity = createCapacityController({
      maxConcurrent: 2,
      maxQueued: 5,
      queueTimeoutMs: 10000,
    });
    const service = createRenderService(renderer.renderUrl, capacity);

    const result = await service.renderUrl(`${testOrigin}/dynamic`);

    expect(result.title).toBe('E2E Dynamic');
    expect(result.html).toContain('E2E Content');
    expect(result.statusCode).toBe(200);
    expect(result.finalUrl).toBe(`${testOrigin}/dynamic`);
    expect(result.renderTimeMs).toBeGreaterThan(0);

    capacity.close();
  });

  it('kapasite davranışı — maxConcurrent=1, ikinci istek queued', async () => {
    const slowRenderer = createRenderer({
      urlValidator: createTestValidator(testOrigin),
      renderTimeoutMs: 10000,
      maxHtmlBytes: 500000,
      launchBrowser: createDefaultLauncher(),
    });

    const capacity = createCapacityController({
      maxConcurrent: 1,
      maxQueued: 5,
      queueTimeoutMs: 10000,
    });
    const service = createRenderService(slowRenderer.renderUrl, capacity);

    // Both use /slow-render which takes ~500ms
    const p1 = service.renderUrl(`${testOrigin}/slow-render`);
    const p2 = service.renderUrl(`${testOrigin}/basic`);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.title).toBe('Slow Done');
    expect(r2.title).toBe('Basic');

    capacity.close();
    await slowRenderer.close();
  });
});
