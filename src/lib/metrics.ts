import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export type RenderResultLabel =
  | 'success'
  | 'render_error'
  | 'validation_error'
  | 'queue_full'
  | 'queue_timeout'
  | 'capacity_closed'
  | 'unauthorized'
  | 'bad_request';

export type UrlRejectionReason =
  | 'protocol'
  | 'credentials'
  | 'hostname'
  | 'port'
  | 'private_ip'
  | 'dns'
  | 'redirect'
  | 'resource'
  | 'unknown';

export interface CapacitySnapshotMetrics {
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
}

export interface Metrics {
  observeRenderDuration: (seconds: number) => void;
  observeQueueWait: (seconds: number) => void;
  incrementRenderResult: (result: RenderResultLabel) => void;
  setCapacitySnapshot: (snapshot: CapacitySnapshotMetrics) => void;
  incrementBrowserLaunch: () => void;
  incrementBrowserDisconnect: () => void;
  incrementBrowserLaunchFailure: () => void;
  incrementUrlRejection: (reason: UrlRejectionReason) => void;
  getMetrics: () => Promise<string>;
  getContentType: () => string;
  reset: () => void;
}

// Render duration covers the actual browser render step (page.goto through
// page.content()) — short renders are common, but a handful of buckets past
// the default 15s timeout catch slow/near-timeout cases too.
const RENDER_DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 20, 30];

// Queue wait covers time spent in RenderCapacityController before a task
// starts executing — bounded by RENDER_QUEUE_TIMEOUT_MS (default 10s, max 120s).
const QUEUE_WAIT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 60];

function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    // Metrics must never break the render path. Log and move on.
    console.error('metrics error (ignored):', err);
  }
}

// Exported so every call site (render-capacity, renderer, browser-launch,
// render route) can defend against a caller-supplied Metrics implementation
// that throws directly — not just the built-in prom-client implementation,
// which already wraps its own methods in `safe()` above.
export function safeMetricsCall(fn: () => void): void {
  safe(fn);
}

export interface CreateMetricsOptions {
  /** Register Node.js process/event-loop default metrics. Off by default in tests. */
  collectDefault?: boolean;
  /** Prefix applied to all metric names, including default metrics. */
  prefix?: string;
}

export function createMetrics(options?: CreateMetricsOptions): Metrics {
  const prefix = options?.prefix ?? 'prerender_';
  const register = new Registry();

  if (options?.collectDefault) {
    // Standard Node.js process/event-loop/GC metrics (CPU, memory, event
    // loop lag, active handles, GC pause histograms if --expose-gc-ish
    // hooks are available). Low cardinality — no per-request labels.
    collectDefaultMetrics({ register, prefix });
  }

  const renderRequestsTotal = new Counter({
    name: `${prefix}render_requests_total`,
    help: 'Total number of render requests by outcome',
    labelNames: ['result'] as const,
    registers: [register],
  });

  const renderDurationSeconds = new Histogram({
    name: `${prefix}render_duration_seconds`,
    help: 'Render duration in seconds (browser render step only)',
    buckets: RENDER_DURATION_BUCKETS,
    registers: [register],
  });

  const queueWaitDurationSeconds = new Histogram({
    name: `${prefix}queue_wait_duration_seconds`,
    help: 'Time spent waiting in the render capacity queue before execution or timeout, in seconds',
    buckets: QUEUE_WAIT_BUCKETS,
    registers: [register],
  });

  const renderActive = new Gauge({
    name: `${prefix}render_active`,
    help: 'Currently executing render tasks',
    registers: [register],
  });

  const renderQueued = new Gauge({
    name: `${prefix}render_queued`,
    help: 'Render tasks currently waiting in queue',
    registers: [register],
  });

  const renderMaxConcurrent = new Gauge({
    name: `${prefix}render_max_concurrent`,
    help: 'Configured maximum concurrent render tasks',
    registers: [register],
  });

  const renderMaxQueued = new Gauge({
    name: `${prefix}render_max_queued`,
    help: 'Configured maximum queued render tasks',
    registers: [register],
  });

  const browserLaunchesTotal = new Counter({
    name: `${prefix}browser_launches_total`,
    help: 'Total successful Chromium browser launches',
    registers: [register],
  });

  const browserDisconnectsTotal = new Counter({
    name: `${prefix}browser_disconnects_total`,
    help: 'Total Chromium browser disconnect events (unexpected disconnects only, not graceful close)',
    registers: [register],
  });

  const browserLaunchFailuresTotal = new Counter({
    name: `${prefix}browser_launch_failures_total`,
    help: 'Total failed Chromium browser launch attempts',
    registers: [register],
  });

  const urlRejectionsTotal = new Counter({
    name: `${prefix}url_rejections_total`,
    help: 'Total URLs rejected by SSRF/security checks, by reason',
    labelNames: ['reason'] as const,
    registers: [register],
  });

  return {
    observeRenderDuration(seconds) {
      safe(() => renderDurationSeconds.observe(seconds));
    },
    observeQueueWait(seconds) {
      safe(() => queueWaitDurationSeconds.observe(seconds));
    },
    incrementRenderResult(result) {
      safe(() => renderRequestsTotal.labels(result).inc());
    },
    setCapacitySnapshot(snapshot) {
      safe(() => {
        renderActive.set(snapshot.active);
        renderQueued.set(snapshot.queued);
        renderMaxConcurrent.set(snapshot.maxConcurrent);
        renderMaxQueued.set(snapshot.maxQueued);
      });
    },
    incrementBrowserLaunch() {
      safe(() => browserLaunchesTotal.inc());
    },
    incrementBrowserDisconnect() {
      safe(() => browserDisconnectsTotal.inc());
    },
    incrementBrowserLaunchFailure() {
      safe(() => browserLaunchFailuresTotal.inc());
    },
    incrementUrlRejection(reason) {
      safe(() => urlRejectionsTotal.labels(reason).inc());
    },
    async getMetrics() {
      try {
        return await register.metrics();
      } catch (err) {
        console.error('metrics error (ignored):', err);
        return '';
      }
    },
    getContentType() {
      return register.contentType;
    },
    reset() {
      safe(() => register.resetMetrics());
    },
  };
}

export function createNoopMetrics(): Metrics {
  return {
    observeRenderDuration() {},
    observeQueueWait() {},
    incrementRenderResult() {},
    setCapacitySnapshot() {},
    incrementBrowserLaunch() {},
    incrementBrowserDisconnect() {},
    incrementBrowserLaunchFailure() {},
    incrementUrlRejection() {},
    async getMetrics() {
      return '';
    },
    getContentType() {
      return 'text/plain';
    },
    reset() {},
  };
}

// Production singleton. Each test that needs isolation should call
// createMetrics() directly instead of importing this.
export const metrics = createMetrics({ collectDefault: true });
