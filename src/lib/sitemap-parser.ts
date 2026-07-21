import sax from 'sax';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

export type SitemapParseFailureReason =
  | 'xml_error'
  | 'dtd_rejected'
  | 'unknown_root'
  | 'limit_exceeded'
  | 'decompress_failed'
  | 'decompress_too_large';

export class SitemapParseError extends Error {
  readonly reason: SitemapParseFailureReason;
  constructor(reason: SitemapParseFailureReason, message: string) {
    super(message);
    this.name = 'SitemapParseError';
    this.reason = reason;
  }
}

export interface ParsedSitemapUrl {
  loc: string;
  lastmod?: string;
  priority?: string;
  changefreq?: string;
}

export interface ParsedSitemap {
  kind: 'urlset' | 'sitemapindex';
  urls: ParsedSitemapUrl[]; // urlset: page URLs. sitemapindex: nested sitemap URLs (loc only).
  truncated: boolean;
}

// Decompresses a gzip buffer with a hard output-byte cap, aborting the
// moment the cap is exceeded rather than after the fact — the core
// defense against decompression-bomb style payloads.
export async function decompressGzipLimited(input: Buffer, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    gunzip.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        if (!settled) {
          settled = true;
          reject(new SitemapParseError('decompress_too_large', `Decompressed output exceeded ${maxBytes} bytes`));
        }
        gunzip.destroy();
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    gunzip.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(new SitemapParseError('decompress_failed', err.message));
      }
    });

    Readable.from(input).pipe(gunzip);
  });
}

// Streaming, non-DOM XML parse using `sax` (strict mode). `sax` does not
// implement DTD/external-entity resolution at all — there is no entity
// expansion code path to exploit, so this is inherently XXE-safe. Any
// <!DOCTYPE ...> is explicitly rejected outright as a second layer of
// defense, and parsing aborts the moment the per-sitemap URL limit is hit
// rather than continuing to buffer more entries.
export function parseSitemapXml(xml: string, maxUrls: number): ParsedSitemap {
  const parser = sax.parser(true, { trim: true, lowercase: true });

  let kind: 'urlset' | 'sitemapindex' | null = null;
  const urls: ParsedSitemapUrl[] = [];
  let truncated = false;
  let currentTag = '';
  let currentEntry: Partial<ParsedSitemapUrl> | null = null;
  let textBuffer = '';
  let parseError: SitemapParseError | null = null;
  let aborted = false;

  function abort(err: SitemapParseError): void {
    parseError = err;
    aborted = true;
  }

  parser.ondoctype = () => {
    abort(new SitemapParseError('dtd_rejected', 'DOCTYPE declarations are not permitted in sitemaps'));
  };

  parser.onopentag = (node) => {
    if (aborted) return;
    const name = node.name;
    if (kind === null) {
      if (name === 'urlset') {
        kind = 'urlset';
        return;
      }
      if (name === 'sitemapindex') {
        kind = 'sitemapindex';
        return;
      }
      abort(new SitemapParseError('unknown_root', `Unexpected root element: ${name}`));
      return;
    }

    if ((kind === 'urlset' && name === 'url') || (kind === 'sitemapindex' && name === 'sitemap')) {
      if (urls.length >= maxUrls) {
        truncated = true;
        return;
      }
      currentEntry = {} as Partial<ParsedSitemapUrl>;
      currentTag = name;
      return;
    }

    if (currentEntry && ['loc', 'lastmod', 'priority', 'changefreq'].includes(name)) {
      currentTag = name;
      textBuffer = '';
    }
  };

  parser.ontext = (text) => {
    if (aborted) return;
    textBuffer += text;
  };

  parser.onclosetag = (name) => {
    if (aborted) return;
    if (currentEntry && ['loc', 'lastmod', 'priority', 'changefreq'].includes(name)) {
      const value = textBuffer.trim();
      textBuffer = '';
      if (value.length > 0) {
        (currentEntry as Record<'loc' | 'lastmod' | 'priority' | 'changefreq', string>)[name as 'loc' | 'lastmod' | 'priority' | 'changefreq'] = value;
      }
      return;
    }
    if ((name === 'url' || name === 'sitemap') && currentEntry) {
      if (currentEntry.loc && urls.length < maxUrls) {
        urls.push(currentEntry as ParsedSitemapUrl);
      }
      currentEntry = null;
      currentTag = '';
    }
  };

  parser.onerror = (err) => {
    if (!aborted) {
      abort(new SitemapParseError('xml_error', err.message));
    }
    // sax keeps parsing after onerror unless we clear the error; since we
    // track `aborted` ourselves and ignore further events, this is safe.
    parser.resume();
  };

  try {
    parser.write(xml).close();
  } catch (err) {
    if (!parseError) {
      throw new SitemapParseError('xml_error', err instanceof Error ? err.message : 'XML parse failed');
    }
  }

  if (parseError) throw parseError;
  if (kind === null) {
    throw new SitemapParseError('unknown_root', 'No urlset or sitemapindex root element found');
  }

  void currentTag;
  return { kind, urls, truncated };
}
