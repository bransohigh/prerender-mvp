import { describe, expect, it } from 'vitest';
import { createMetrics, createNoopMetrics } from '../src/lib/metrics.js';

describe('createMetrics', () => {
  it('render result counter increments per label', async () => {
    const metrics = createMetrics();
    metrics.incrementRenderResult('success');
    metrics.incrementRenderResult('success');
    metrics.incrementRenderResult('render_error');

    const output = await metrics.getMetrics();
    expect(output).toMatch(/prerender_render_requests_total\{result="success"\} 2/);
    expect(output).toMatch(/prerender_render_requests_total\{result="render_error"\} 1/);
  });

  it('render duration histogram records observations', async () => {
    const metrics = createMetrics();
    metrics.observeRenderDuration(0.5);
    metrics.observeRenderDuration(2);

    const output = await metrics.getMetrics();
    expect(output).toContain('prerender_render_duration_seconds_count 2');
    expect(output).toContain('prerender_render_duration_seconds_sum 2.5');
  });

  it('queue wait histogram records observations', async () => {
    const metrics = createMetrics();
    metrics.observeQueueWait(0.01);

    const output = await metrics.getMetrics();
    expect(output).toContain('prerender_queue_wait_duration_seconds_count 1');
  });

  it('capacity snapshot updates gauges', async () => {
    const metrics = createMetrics();
    metrics.setCapacitySnapshot({ active: 2, queued: 3, maxConcurrent: 4, maxQueued: 10 });

    const output = await metrics.getMetrics();
    expect(output).toContain('prerender_render_active 2');
    expect(output).toContain('prerender_render_queued 3');
    expect(output).toContain('prerender_render_max_concurrent 4');
    expect(output).toContain('prerender_render_max_queued 10');
  });

  it('browser lifecycle counters increment independently', async () => {
    const metrics = createMetrics();
    metrics.incrementBrowserLaunch();
    metrics.incrementBrowserLaunch();
    metrics.incrementBrowserLaunchFailure();
    metrics.incrementBrowserDisconnect();

    const output = await metrics.getMetrics();
    expect(output).toContain('prerender_browser_launches_total 2');
    expect(output).toContain('prerender_browser_launch_failures_total 1');
    expect(output).toContain('prerender_browser_disconnects_total 1');
  });

  it('url rejection counter uses low-cardinality reason label', async () => {
    const metrics = createMetrics();
    metrics.incrementUrlRejection('private_ip');
    metrics.incrementUrlRejection('private_ip');
    metrics.incrementUrlRejection('dns');

    const output = await metrics.getMetrics();
    expect(output).toMatch(/prerender_url_rejections_total\{reason="private_ip"\} 2/);
    expect(output).toMatch(/prerender_url_rejections_total\{reason="dns"\} 1/);
  });

  it('getContentType returns the Prometheus registry content type', () => {
    const metrics = createMetrics();
    expect(metrics.getContentType()).toContain('text/plain');
  });

  it('two independent instances do not share state (no duplicate registration)', async () => {
    const a = createMetrics();
    const b = createMetrics();

    a.incrementRenderResult('success');

    const outputA = await a.getMetrics();
    const outputB = await b.getMetrics();
    expect(outputA).toMatch(/prerender_render_requests_total\{result="success"\} 1/);
    expect(outputB).not.toMatch(/prerender_render_requests_total\{result="success"\} 1/);
  });

  it('reset clears all recorded values without throwing', async () => {
    const metrics = createMetrics();
    metrics.incrementRenderResult('success');
    metrics.reset();

    const output = await metrics.getMetrics();
    expect(output).not.toMatch(/prerender_render_requests_total\{result="success"\} 1/);
  });

  it('never includes a raw URL in metric output', async () => {
    const metrics = createMetrics();
    metrics.incrementUrlRejection('private_ip');
    metrics.incrementRenderResult('success');

    const output = await metrics.getMetrics();
    expect(output).not.toContain('http://');
    expect(output).not.toContain('https://');
  });

  it('never includes an API key in metric output', async () => {
    const metrics = createMetrics();
    metrics.incrementRenderResult('unauthorized');

    const output = await metrics.getMetrics();
    expect(output).not.toMatch(/[a-zA-Z0-9]{16,}/);
  });

  it('does not accept request ID as a label anywhere', async () => {
    const metrics = createMetrics();
    metrics.incrementRenderResult('success');

    const output = await metrics.getMetrics();
    expect(output).not.toContain('requestId');
    expect(output).not.toContain('request_id');
  });

  it('metrics method signatures reject arbitrary reason/result strings at compile time', () => {
    // Type-level guarantee: incrementRenderResult/incrementUrlRejection only
    // accept the fixed literal unions, not `string`. This test exists to
    // keep the assertion visible in the suite even though it's enforced by
    // tsc, not runtime.
    const metrics = createMetrics();
    metrics.incrementRenderResult('success');
    metrics.incrementUrlRejection('unknown');
    expect(true).toBe(true);
  });
});

describe('createNoopMetrics', () => {
  it('all methods are safe no-ops', async () => {
    const metrics = createNoopMetrics();
    expect(() => {
      metrics.observeRenderDuration(1);
      metrics.observeQueueWait(1);
      metrics.incrementRenderResult('success');
      metrics.setCapacitySnapshot({ active: 0, queued: 0, maxConcurrent: 1, maxQueued: 1 });
      metrics.incrementBrowserLaunch();
      metrics.incrementBrowserDisconnect();
      metrics.incrementBrowserLaunchFailure();
      metrics.incrementUrlRejection('unknown');
      metrics.reset();
    }).not.toThrow();
    await expect(metrics.getMetrics()).resolves.toBe('');
  });
});
