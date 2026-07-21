import http from 'node:http';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { createRenderer } from '../../src/services/renderer.js';
import { createDefaultLauncher } from '../../src/lib/browser-launch.js';
import { createCapacityController } from '../../src/services/render-capacity.js';
import { createRenderService } from '../../src/services/render-service.js';
import { createMetrics } from '../../src/lib/metrics.js';
import type { UrlValidator } from '../../src/types/render.js';

// See test/integration/e2e.test.ts for why these bypass the Fastify
// /v1/render HTTP route (domain authorization requires HTTPS+443+a
// verified domain, which a local ephemeral HTTP test server can't satisfy)
// and instead exercise createRenderService() directly.

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
    const capacity = createCapacityController({ maxConcurrent: 2, maxQueued: 5, queueTimeoutMs: 5000, metrics });
    const service = createRenderService(renderer.renderUrl, capacity);

    try {
      const result = await service.renderUrl(`${testOrigin}/`);
      expect(result.statusCode).toBe(200);

      const output = await metrics.getMetrics();
      expect(output).toMatch(/prerender_render_duration_seconds_count 1/);
      expect(output).toContain('prerender_browser_launches_total 1');
    } finally {
      capacity.close();
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
    const capacity = createCapacityController({ maxConcurrent: 2, maxQueued: 5, queueTimeoutMs: 5000, metrics });
    const service = createRenderService(renderer.renderUrl, capacity);

    try {
      await service.renderUrl(`${testOrigin}/`);

      const output = await metrics.getMetrics();
      expect(output).toContain('prerender_render_active 0');
      expect(output).toContain('prerender_render_queued 0');
    } finally {
      capacity.close();
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

  it('queue timeout sonucu doğru sayaç ile artar', async () => {
    const metrics = createMetrics();
    const renderer = createRenderer({
      urlValidator: createTestValidator(testOrigin),
      launchBrowser: createDefaultLauncher({ metrics }),
      metrics,
    });
    const capacity = createCapacityController({
      maxConcurrent: 1,
      maxQueued: 5,
      queueTimeoutMs: 50,
      metrics,
    });
    const service = createRenderService(renderer.renderUrl, capacity);

    try {
      const p1 = service.renderUrl(`${testOrigin}/slow`);

      // Give the first request time to occupy the single concurrent slot.
      await new Promise((r) => setTimeout(r, 20));

      await expect(service.renderUrl(`${testOrigin}/`)).rejects.toThrow();

      const output = await metrics.getMetrics();
      expect(output).toContain('prerender_queue_wait_duration_seconds_count');

      await p1;
    } finally {
      capacity.close();
      await renderer.close();
    }
  });
});
