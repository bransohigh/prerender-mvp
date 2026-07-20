import type { Browser, BrowserContext } from 'playwright';
import { env } from '../config/env.js';
import { assertSafePublicUrl } from '../lib/url-security.js';
import { createDefaultLauncher } from '../lib/browser-launch.js';
import type {
  RenderResult,
  RendererOptions,
  UrlValidator,
} from '../types/render.js';

export interface Renderer {
  renderUrl: (rawUrl: string) => Promise<RenderResult>;
  close: () => Promise<void>;
}

export function createRenderer(options?: RendererOptions): Renderer {
  const urlValidator: UrlValidator =
    options?.urlValidator ?? assertSafePublicUrl;
  const renderTimeoutMs = options?.renderTimeoutMs ?? env.RENDER_TIMEOUT_MS;
  const maxHtmlBytes = options?.maxHtmlBytes ?? env.MAX_HTML_BYTES;
  const launchBrowser =
    options?.launchBrowser ??
    createDefaultLauncher({
      proxyUrl: env.OUTBOUND_PROXY_URL,
      sandbox: process.platform === 'linux',
    });

  let browserPromise: Promise<Browser> | null = null;

  function resetBrowserPromise(): void {
    browserPromise = null;
  }

  async function getBrowser(): Promise<Browser> {
    if (browserPromise) {
      try {
        const browser = await browserPromise;
        if (browser.isConnected()) return browser;
      } catch {
        // launch failed previously — fall through to retry
      }
      resetBrowserPromise();
    }

    browserPromise = launchBrowser();

    const browser = await browserPromise.catch((err) => {
      resetBrowserPromise();
      throw err;
    });

    browser.on('disconnected', resetBrowserPromise);
    return browser;
  }

  async function hardenContext(context: BrowserContext): Promise<void> {
    // Context-level route intercepts all pages and popups within the context.
    // NOTE: This does NOT prevent DNS rebinding during Chromium's actual TCP
    // connection. The DNS lookup here runs in Node.js and may resolve to a
    // different IP than Chromium's resolver. See SECURITY.md for details.
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();

      try {
        await urlValidator(url);
      } catch {
        await route.abort('blockedbyclient');
        return;
      }

      if (['media', 'font'].includes(request.resourceType())) {
        await route.abort();
        return;
      }

      await route.continue();
    });
  }

  async function renderUrl(rawUrl: string): Promise<RenderResult> {
    const safeUrl = await urlValidator(rawUrl);
    const startedAt = Date.now();
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent:
        'CrawlerVisibilityBot/0.1 (+https://example.invalid/bot; prerender testing)',
      javaScriptEnabled: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });

    try {
      await hardenContext(context);

      const page = await context.newPage();

      context.on('page', async (popup) => {
        if (popup !== page) {
          try {
            await popup.close();
          } catch {
            // popup may already be closed
          }
        }
      });
      page.setDefaultNavigationTimeout(renderTimeoutMs);
      page.setDefaultTimeout(renderTimeoutMs);

      const response = await page.goto(safeUrl.toString(), {
        waitUntil: 'networkidle',
        timeout: renderTimeoutMs,
      });

      await urlValidator(page.url());

      const html = await page.content();
      const htmlBytes = Buffer.byteLength(html, 'utf8');
      if (htmlBytes > maxHtmlBytes) {
        throw new Error(`HTML boyutu sınırı aşıldı: ${htmlBytes} byte`);
      }

      return {
        url: safeUrl.toString(),
        finalUrl: page.url(),
        statusCode: response?.status() ?? null,
        title: await page.title(),
        html,
        renderTimeMs: Date.now() - startedAt,
        renderedAt: new Date().toISOString(),
      };
    } finally {
      await context.close();
    }
  }

  async function close(): Promise<void> {
    if (!browserPromise) return;
    const promise = browserPromise;
    resetBrowserPromise();
    try {
      const browser = await promise;
      if (browser.isConnected()) {
        await browser.close();
      }
    } catch {
      // browser was never successfully launched or already closed
    }
  }

  return { renderUrl, close };
}

const defaultRenderer = createRenderer();

export const renderUrl = defaultRenderer.renderUrl;
export const closeRenderer = defaultRenderer.close;
