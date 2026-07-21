// Extracts only "Sitemap:" directives from a robots.txt body. Does not
// attempt to interpret Allow/Disallow/User-agent or any other directive —
// this system only discovers sitemap URLs from robots.txt, it does not
// enforce crawl rules.
export function extractSitemapDirectives(robotsBody: string, maxEntries = 50): string[] {
  const urls: string[] = [];

  for (const rawLine of robotsBody.split(/\r\n|\r|\n/)) {
    if (urls.length >= maxEntries) break;

    // Strip comments (# to end of line), then trim.
    const withoutComment = rawLine.split('#')[0] ?? '';
    const line = withoutComment.trim();
    if (line.length === 0) continue;

    const match = /^sitemap\s*:\s*(.+)$/i.exec(line);
    if (!match) continue;

    const url = match[1]!.trim();
    if (url.length > 0) {
      urls.push(url);
    }
  }

  return urls;
}
