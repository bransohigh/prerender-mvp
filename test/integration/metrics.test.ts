import http from 'node:http';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createRenderer } from '../../src/services/renderer.js';
import { createDefaultLauncher } from '../../src/lib/browser-launch.js';
import { createMetrics } from '../../src/lib/metrics.js';
import type { UrlValidator } from '../../src/types/render.js';

const VALID_API_KEY = process.env['API_KEY'] ?? 'test-api-key-12345';

let testServer: http.Server;
let testOrigin: string;

function createTestValidator(allowedOrigin: string): UrlValidator {
  return async (rawUrl: string): Promise<URL> => {
    const parsed = new URL(rawUrl);
    if (parsed.origin !== allowedOrigin) {
      throw new Error(`Test validator: ${parsed.origin} is not allowed`);
    }
    return parsed;
  };
}

function createTestServer(): Promise<{ server: http.Server; origin: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/slow') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><head><title>Slow</title></head><body>
          <script>
            const start = Date.now();
            while (Date.now() - start < 300) {}
            document.title = 'Slow Done';
          </script>
        </body></html>`);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Basic</title></head><body>OK</body></html>');
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
});

afterAll(async () => {
  await new Promise<void>((resolve) => testServer.close(() => resolve()));
});

describe('Metrics integration (real Chromium)', () => {
  it('başarılı render sonrası success counter artar ve duration histogram doldurulur', async () => {
    const metrics = createMetrics();
    const renderer = createRenderer({
      urlValidator: createTestValidator(testOrigin),
      launchBrowser: createDefaultLauncher({ metrics }),
      metrics,
    });
    const app = await buildApp({ renderUrl: renderer.renderUrl, metrics });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/render',
        headers: { 'x-api-key': VALID_API_KEY },
        payload: { url: `${testOrigin}/` },
      });
      expect(res.statusCode).toBe(200);

      const output = await metrics.getMetrics();
      expect(output).toMatch(/prerender_render_requests_total\{result="success"\} 1/);
      expect(output).toContain('prerender_render_duration_seconds_count 1');
      expect(output).toContain('prerender_browser_launches_total 1');
    } finally {
      await app.close();
      await renderer.close();
    }
  });

  it('render sonrası active ve queued gauge sıfırdır', async () => {
    const metrics = createMetrics();
    const renderer = createRenderer({
      urlValidator: createTestValidator(testOrigin),
      launchBrowser: createDefaultLauncher({ metrics }),
      metrics,
    });
    const app = await buildApp({ renderUrl: renderer.renderUrl, metrics });

    try {
      await app.inject({
        method: 'POST',
        url: '/v1/render',
        headers: { 'x-api-key': VALID_API_KEY },
        payload: { url: `${testOrigin}/` },
      });

      const output = await metrics.getMetrics();
      expect(output).toContain('prerender_render_active 0');
      expect(output).toContain('prerender_render_queued 0');
    } finally {
      await app.close();
      await renderer.close();
    }
  });

  it('browser recovery sonrasında launch metric tekrar artar', async () => {
    const metrics = createMetrics();
    const renderer = createRenderer({
      urlValidator: createTestValidator(testOrigin),
      launchBrowser: createDefaultLauncher({ metrics }),
      metrics,
    });

    try {
      await renderer.renderUrl(`${testOrigin}/`);
      await renderer.close();

      // Closing intentionally must NOT count as an unexpected disconnect.
      let output = await metrics.getMetrics();
      expect(output).toContain('prerender_browser_launches_total 1');
      expect(output).toContain('prerender_browser_disconnects_total 0');

      // Next render must relaunch (browserPromise was reset by close()).
      await renderer.renderUrl(`${testOrigin}/`);
      output = await metrics.getMetrics();
      expect(output).toContain('prerender_browser_launches_total 2');
    } finally {
      await renderer.close();
    }
  });

  it('queue timeout sonucu doğru result label ile artar', async () => {
    const metrics = createMetrics();
    const renderer = createRenderer({
      urlValidator: createTestValidator(testOrigin),
      launchBrowser: createDefaultLauncher({ metrics }),
      metrics,
    });
    const app = await buildApp({
      renderUrl: renderer.renderUrl,
      maxConcurrentRenders: 1,
      maxQueuedRenders: 5,
      renderQueueTimeoutMs: 50,
      metrics,
    });

    try {
      const p1 = app.inject({
        method: 'POST',
        url: '/v1/render',
        headers: { 'x-api-key': VALID_API_KEY },
        payload: { url: `${testOrigin}/slow` },
      });

      // Give the first request time to occupy the single concurrent slot.
      await new Promise((r) => setTimeout(r, 20));

      const r2 = await app.inject({
        method: 'POST',
        url: '/v1/render',
        headers: { 'x-api-key': VALID_API_KEY },
        payload: { url: `${testOrigin}/` },
      });
      expect(r2.statusCode).toBe(503);

      const output = await metrics.getMetrics();
      expect(output).toMatch(/prerender_render_requests_total\{result="queue_timeout"\} 1/);

      await p1;
    } finally {
      await app.close();
      await renderer.close();
    }
  });
});
