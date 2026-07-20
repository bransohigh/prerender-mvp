import http from 'node:http';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { createRenderer, type Renderer } from '../../src/services/renderer.js';
import type { UrlValidator } from '../../src/types/render.js';

let testServer: http.Server;
let testOrigin: string;
let renderer: Renderer;

const resourceHits: Record<string, number> = {};

function resetResourceHits() {
  for (const key of Object.keys(resourceHits)) {
    delete resourceHits[key];
  }
}

function createTestServer(): Promise<{ server: http.Server; origin: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';

      if (url === '/basic') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head><title>Test Page</title></head><body><p>Hello World</p></body></html>');
        return;
      }

      if (url === '/dynamic') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><head><title>Loading</title></head><body>
          <p id="content">Initial</p>
          <script>
            document.title = 'Dynamic Title';
            document.getElementById('content').textContent = 'Dynamic Content';
          </script>
        </body></html>`);
        return;
      }

      if (url === '/cookie-set') {
        res.writeHead(200, {
          'content-type': 'text/html',
          'set-cookie': 'session=abc123; Path=/',
        });
        res.end(`<html><head><title>Cookie Set</title></head><body>
          <p id="val">none</p>
          <script>
            localStorage.setItem('testKey', 'testValue');
            document.getElementById('val').textContent = document.cookie;
          </script>
        </body></html>`);
        return;
      }

      if (url === '/cookie-check') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><head><title>Cookie Check</title></head><body>
          <p id="cookie"></p>
          <p id="storage"></p>
          <script>
            document.getElementById('cookie').textContent = 'cookie:' + document.cookie;
            document.getElementById('storage').textContent = 'storage:' + (localStorage.getItem('testKey') ?? '');
          </script>
        </body></html>`);
        return;
      }

      if (url === '/large-html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        const bigChunk = 'A'.repeat(2000);
        res.end(`<html><head><title>Large</title></head><body>${bigChunk}</body></html>`);
        return;
      }

      if (url === '/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html><head><title>Slow</title></head><body>Done</body></html>');
        }, 30000);
        return;
      }

      if (url === '/popup') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><head><title>Popup Test</title></head><body>
          <script>window.open('about:blank', '_blank');</script>
          <p>Main page</p>
        </body></html>`);
        return;
      }

      if (url === '/download') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="test.bin"',
        });
        res.end('binary-data');
        return;
      }

      if (url === '/download-page') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><head><title>Download Page</title></head><body>
          <a id="dl" href="/download" download>Download</a>
          <script>document.getElementById('dl').click();</script>
        </body></html>`);
        return;
      }

      if (url === '/resource-page') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><head>
          <title>Resource Page</title>
          <link rel="stylesheet" href="/res/style.css">
        </head><body>
          <img src="/res/image.png" />
          <audio src="/res/audio.mp3"></audio>
          <script src="/res/script.js"></script>
        </body></html>`);
        return;
      }

      if (url?.startsWith('/res/')) {
        const resName = url.slice(5);
        resourceHits[resName] = (resourceHits[resName] ?? 0) + 1;

        if (resName === 'style.css') {
          res.writeHead(200, { 'content-type': 'text/css' });
          res.end('body { color: red; }');
          return;
        }
        if (resName === 'script.js') {
          res.writeHead(200, { 'content-type': 'application/javascript' });
          res.end('document.title = "With Script";');
          return;
        }
        // image, audio — minimal response
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('fake');
        return;
      }

      if (url === '/redirect') {
        res.writeHead(302, { location: '/basic' });
        res.end();
        return;
      }

      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><head><title>Not Found</title></head><body>404</body></html>');
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve({ server, origin: `http://127.0.0.1:${addr.port}` });
      }
    });
  });
}

function createTestValidator(allowedOrigin: string): UrlValidator {
  return async (rawUrl: string): Promise<URL> => {
    const parsed = new URL(rawUrl);
    const urlOrigin = parsed.origin;
    if (urlOrigin !== allowedOrigin) {
      throw new Error(`Test validator: ${urlOrigin} is not allowed (only ${allowedOrigin})`);
    }
    return parsed;
  };
}

beforeAll(async () => {
  const result = await createTestServer();
  testServer = result.server;
  testOrigin = result.origin;
  renderer = createRenderer({
    urlValidator: createTestValidator(testOrigin),
    renderTimeoutMs: 5000,
    maxHtmlBytes: 1500,
  });
});

afterAll(async () => {
  await renderer.close();
  await new Promise<void>((resolve) => testServer.close(() => resolve()));
});

describe('renderer integration', () => {
  it('/basic — HTML, title, statusCode, finalUrl doğru', async () => {
    const result = await renderer.renderUrl(`${testOrigin}/basic`);
    expect(result.statusCode).toBe(200);
    expect(result.title).toBe('Test Page');
    expect(result.html).toContain('Hello World');
    expect(result.finalUrl).toBe(`${testOrigin}/basic`);
    expect(result.url).toBe(`${testOrigin}/basic`);
    expect(result.renderTimeMs).toBeGreaterThan(0);
    expect(result.renderedAt).toBeTruthy();
  });

  it('/dynamic — JavaScript render sonrası içerik doğru', async () => {
    const result = await renderer.renderUrl(`${testOrigin}/dynamic`);
    expect(result.title).toBe('Dynamic Title');
    expect(result.html).toContain('Dynamic Content');
  });

  it('context izolasyonu — cookie ve localStorage taşınmaz', async () => {
    await renderer.renderUrl(`${testOrigin}/cookie-set`);
    const result = await renderer.renderUrl(`${testOrigin}/cookie-check`);
    expect(result.html).toContain('cookie:');
    expect(result.html).not.toContain('abc123');
    expect(result.html).toContain('storage:');
    expect(result.html).not.toContain('testValue');
  });

  it('/large-html — boyut sınırı aşıldığında hata verir', async () => {
    // maxHtmlBytes is 1500, /large-html returns ~2100+ bytes
    await expect(renderer.renderUrl(`${testOrigin}/large-html`)).rejects.toThrow(
      'HTML boyutu sınırı aşıldı',
    );
  });

  it('/slow — timeout sonrası kontrollü hata', async () => {
    // renderTimeoutMs is 5000, /slow waits 30s
    await expect(renderer.renderUrl(`${testOrigin}/slow`)).rejects.toThrow();
  });

  it('/popup — popup kalıcı açık page bırakmaz', async () => {
    const result = await renderer.renderUrl(`${testOrigin}/popup`);
    expect(result.title).toBe('Popup Test');
    expect(result.html).toContain('Main page');
  });

  it('/download-page — download diske yazılmaz, render devam eder', async () => {
    const result = await renderer.renderUrl(`${testOrigin}/download-page`);
    expect(result.title).toBe('Download Page');
  });

  it('/resource-page — media ve font bloklanır, script ve css geçer', async () => {
    resetResourceHits();
    const result = await renderer.renderUrl(`${testOrigin}/resource-page`);
    expect(result.title).toBe('With Script');

    // script and stylesheet should have been loaded
    expect(resourceHits['script.js']).toBeGreaterThan(0);
    expect(resourceHits['style.css']).toBeGreaterThan(0);

    // media should be blocked by hardenContext
    expect(resourceHits['audio.mp3']).toBeUndefined();
  });

  it('/redirect — aynı origin içi redirect, finalUrl doğru', async () => {
    const result = await renderer.renderUrl(`${testOrigin}/redirect`);
    expect(result.finalUrl).toBe(`${testOrigin}/basic`);
    expect(result.title).toBe('Test Page');
  });

  it('izin verilmeyen origin reddedilir', async () => {
    await expect(renderer.renderUrl('https://example.com')).rejects.toThrow(
      'not allowed',
    );
  });
});

describe('browser recovery', () => {
  it('browser disconnect sonrası yeni render başarılı olur', async () => {
    // Use a separate renderer with a custom launcher we can track
    let launchCount = 0;
    const { chromium: pw } = await import('playwright');

    const recoveryRenderer = createRenderer({
      urlValidator: createTestValidator(testOrigin),
      renderTimeoutMs: 5000,
      maxHtmlBytes: 50000,
      launchBrowser: async () => {
        launchCount++;
        return pw.launch({
          headless: true,
          args: ['--disable-dev-shm-usage', '--no-first-run'],
        });
      },
    });

    try {
      // First render — should launch browser
      const r1 = await recoveryRenderer.renderUrl(`${testOrigin}/basic`);
      expect(r1.title).toBe('Test Page');
      expect(launchCount).toBe(1);

      // Force close the browser to simulate crash
      await recoveryRenderer.close();

      // Second render — should launch a new browser
      const r2 = await recoveryRenderer.renderUrl(`${testOrigin}/basic`);
      expect(r2.title).toBe('Test Page');
      expect(launchCount).toBe(2);
    } finally {
      await recoveryRenderer.close();
    }
  });
});
