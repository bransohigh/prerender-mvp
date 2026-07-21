import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { assertSafePublicUrl } from './url-security.js';
import type { UrlValidator } from '../types/render.js';

export type SafeFetchFailureReason =
  | 'blocked_url'
  | 'too_many_redirects'
  | 'redirect_host_mismatch'
  | 'redirect_downgrade'
  | 'too_large'
  | 'timeout'
  | 'network_error'
  | 'unexpected_status';

export class SafeFetchError extends Error {
  readonly reason: SafeFetchFailureReason;
  constructor(reason: SafeFetchFailureReason, message: string) {
    super(message);
    this.name = 'SafeFetchError';
    this.reason = reason;
  }
}

export interface SafeFetchResult {
  status: number;
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface SafeFetchOptions {
  proxyUrl?: string;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  requiredHostname?: string;
  // Test injection point only — production always uses the default
  // (assertSafePublicUrl). Mirrors the same DI pattern already used for
  // the renderer's Chromium-side urlValidator.
  urlValidator?: UrlValidator;
}

// A CONNECT-tunnel HTTPS agent so verification/sitemap requests egress
// through the same forward proxy as Chromium (OUTBOUND_PROXY_URL), rather
// than bypassing it. No third-party proxy-agent dependency — built on
// Node core net/tls only. TLS verification is never disabled
// (rejectUnauthorized left at its secure default).
class ProxyHttpsAgent extends https.Agent {
  constructor(private readonly proxyHost: string, private readonly proxyPort: number) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: https.RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const cb = callback ?? (() => {});
    const targetHost = options.host!;
    const targetPort = options.port ? Number(options.port) : 443;
    const servername = (options as { servername?: string }).servername ?? targetHost;
    const proxySocket = net.connect(this.proxyPort, this.proxyHost);

    let buffered = '';
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('latin1');
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      proxySocket.removeListener('data', onData);

      const statusLine = buffered.slice(0, buffered.indexOf('\r\n'));
      if (!/^HTTP\/1\.[01]\s+200/.test(statusLine)) {
        cb(new Error(`Proxy CONNECT failed: ${statusLine}`), proxySocket);
        proxySocket.destroy();
        return;
      }

      const tlsSocket = tls.connect({
        socket: proxySocket,
        servername,
        host: targetHost,
        // rejectUnauthorized intentionally left at the secure default (true).
      });
      tlsSocket.once('secureConnect', () => cb(null, tlsSocket));
      tlsSocket.once('error', (err) => cb(err, tlsSocket));
    };

    proxySocket.once('connect', () => {
      proxySocket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nConnection: close\r\n\r\n`,
      );
    });
    proxySocket.on('data', onData);
    proxySocket.once('error', (err) => cb(err, proxySocket));

    return undefined;
  }
}

function buildAgent(proxyUrl?: string): https.Agent {
  if (!proxyUrl) {
    return new https.Agent({ keepAlive: false });
  }
  const parsed = new URL(proxyUrl);
  return new ProxyHttpsAgent(parsed.hostname, Number(parsed.port) || 3128);
}

async function singleRequest(
  url: URL,
  agent: https.Agent,
  maxBytes: number,
  timeoutMs: number,
): Promise<SafeFetchResult> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        agent,
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          'user-agent': 'CrawlerVisibilityBot/0.1 (+https://example.invalid/bot; verification)',
          accept: 'text/plain, application/xml, text/xml, */*;q=0.1',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;

        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            aborted = true;
            req.destroy();
            reject(new SafeFetchError('too_large', `Response exceeded ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          if (aborted) return;
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            headers: res.headers,
          });
        });

        res.on('error', () => {
          if (!aborted) reject(new SafeFetchError('network_error', 'Response stream error'));
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new SafeFetchError('timeout', 'Request timed out'));
    });
    req.on('error', (err) => {
      reject(new SafeFetchError('network_error', err.message));
    });
    req.end();
  });
}

// Safe GET for domain verification and sitemap fetch: HTTPS only, small
// controlled redirect count (must stay on the same required hostname, no
// downgrade to HTTP), response byte cap enforced during streaming (not
// after buffering the whole body), app-level SSRF/DNS check
// (assertSafePublicUrl) run before every hop, and egress through the
// configured OUTBOUND_PROXY_URL when set. TLS verification is never
// disabled. No cookies are stored (Node's http client doesn't do this by
// default) and no browser is used.
// Pure per-hop validation (initial request AND every redirect target):
// HTTPS-only (no downgrade), and — when a required hostname is given —
// exact hostname match (no automatic subdomain/cross-host redirects).
// Exported and unit-tested directly since it needs no network I/O.
export function assertValidHop(parsed: URL, requiredHostname?: string): void {
  if (parsed.protocol !== 'https:') {
    throw new SafeFetchError('redirect_downgrade', 'Only HTTPS is permitted');
  }
  if (requiredHostname && parsed.hostname !== requiredHostname) {
    throw new SafeFetchError('redirect_host_mismatch', 'URL hostname does not match required hostname');
  }
}

// Pure redirect-count check, unit-tested alongside assertValidHop.
export function assertRedirectBudget(redirects: number, maxRedirects: number): void {
  if (redirects > maxRedirects) {
    throw new SafeFetchError('too_many_redirects', 'Too many redirects');
  }
}

export async function safeFetch(
  initialUrl: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  let currentUrl = initialUrl;
  let redirects = 0;

  for (;;) {
    const validate = options.urlValidator ?? assertSafePublicUrl;
    let parsed: URL;
    try {
      parsed = await validate(currentUrl);
    } catch (err) {
      throw new SafeFetchError(
        'blocked_url',
        err instanceof Error ? err.message : 'URL rejected by SSRF policy',
      );
    }

    assertValidHop(parsed, options.requiredHostname);

    const agent = buildAgent(options.proxyUrl);
    const result = await singleRequest(parsed, agent, options.maxBytes, options.timeoutMs);

    if (result.status >= 300 && result.status < 400 && result.headers.location) {
      redirects++;
      assertRedirectBudget(redirects, options.maxRedirects);
      const location = Array.isArray(result.headers.location)
        ? result.headers.location[0]
        : result.headers.location;
      currentUrl = new URL(location!, parsed).toString();
      continue;
    }

    return result;
  }
}
