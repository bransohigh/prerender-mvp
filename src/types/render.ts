export interface RenderResult {
  url: string;
  finalUrl: string;
  statusCode: number | null;
  title: string;
  html: string;
  renderTimeMs: number;
  renderedAt: string;
}

export type UrlValidator = (rawUrl: string) => Promise<URL>;

export type RenderFn = (rawUrl: string) => Promise<RenderResult>;

export interface RendererOptions {
  urlValidator?: UrlValidator;
  renderTimeoutMs?: number;
  maxHtmlBytes?: number;
  launchBrowser?: () => Promise<import('playwright').Browser>;
  metrics?: import('../lib/metrics.js').Metrics;
}
