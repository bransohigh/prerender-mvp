import { describe, expect, it, afterEach } from 'vitest';
import {
  createCapacityController,
  type RenderCapacityController,
} from '../src/services/render-capacity.js';
import { createMetrics } from '../src/lib/metrics.js';

function defer<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function gaugeValue(output: string, name: string): number {
  const match = output.match(new RegExp(`^${name} (\\d+)$`, 'm'));
  return match ? Number(match[1]) : NaN;
}

let controller: RenderCapacityController | null = null;

afterEach(() => {
  controller?.close();
  controller = null;
});

describe('RenderCapacityController metrics integration', () => {
  it('active gauge is 1 while a task runs and 0 after it completes', async () => {
    const metrics = createMetrics();
    controller = createCapacityController({
      maxConcurrent: 1,
      maxQueued: 5,
      queueTimeoutMs: 5000,
      metrics,
    });

    const d1 = defer();
    const p1 = controller.run(() => d1.promise);
    await Promise.resolve();

    let output = await metrics.getMetrics();
    expect(gaugeValue(output, 'prerender_render_active')).toBe(1);

    d1.resolve();
    await p1;
    await Promise.resolve();

    output = await metrics.getMetrics();
    expect(gaugeValue(output, 'prerender_render_active')).toBe(0);
  });

  it('queued gauge is 1 while a task waits and 0 once it starts', async () => {
    const metrics = createMetrics();
    controller = createCapacityController({
      maxConcurrent: 1,
      maxQueued: 5,
      queueTimeoutMs: 5000,
      metrics,
    });

    const blocker = defer();
    controller.run(() => blocker.promise);
    const d2 = defer();
    controller.run(() => d2.promise);
    await Promise.resolve();

    let output = await metrics.getMetrics();
    expect(gaugeValue(output, 'prerender_render_queued')).toBe(1);

    blocker.resolve();
    await Promise.resolve();
    await Promise.resolve();

    output = await metrics.getMetrics();
    expect(gaugeValue(output, 'prerender_render_queued')).toBe(0);

    d2.resolve();
  });

  it('queue timeout brings queued gauge back to 0', async () => {
    const metrics = createMetrics();
    controller = createCapacityController({
      maxConcurrent: 1,
      maxQueued: 5,
      queueTimeoutMs: 30,
      metrics,
    });

    const blocker = defer();
    controller.run(() => blocker.promise);

    await expect(controller.run(async () => {})).rejects.toThrow();

    const output = await metrics.getMetrics();
    expect(gaugeValue(output, 'prerender_render_queued')).toBe(0);
    expect(output).toContain('prerender_queue_wait_duration_seconds_count 2');

    blocker.resolve();
  });

  it('queue full rejection does not change the queued gauge', async () => {
    const metrics = createMetrics();
    controller = createCapacityController({
      maxConcurrent: 1,
      maxQueued: 1,
      queueTimeoutMs: 5000,
      metrics,
    });

    const blocker = defer();
    controller.run(() => blocker.promise);
    controller.run(async () => {});
    await Promise.resolve();

    const before = gaugeValue(await metrics.getMetrics(), 'prerender_render_queued');
    expect(before).toBe(1);

    await expect(controller.run(async () => {})).rejects.toThrow();

    const after = gaugeValue(await metrics.getMetrics(), 'prerender_render_queued');
    expect(after).toBe(1);

    blocker.resolve();
  });

  it('close cancels queued tasks and drops the queued gauge to 0', async () => {
    const metrics = createMetrics();
    controller = createCapacityController({
      maxConcurrent: 1,
      maxQueued: 5,
      queueTimeoutMs: 5000,
      metrics,
    });

    const blocker = defer();
    const p1 = controller.run(() => blocker.promise);
    const p2 = controller.run(async () => {});

    await Promise.resolve();
    expect(gaugeValue(await metrics.getMetrics(), 'prerender_render_queued')).toBe(1);

    controller.close();
    await expect(p2).rejects.toThrow();

    expect(gaugeValue(await metrics.getMetrics(), 'prerender_render_queued')).toBe(0);

    blocker.resolve();
    await p1;
  });

  it('task that skips the queue records ~0 queue wait', async () => {
    const metrics = createMetrics();
    controller = createCapacityController({
      maxConcurrent: 2,
      maxQueued: 5,
      queueTimeoutMs: 5000,
      metrics,
    });

    await controller.run(async () => 'done');

    const output = await metrics.getMetrics();
    expect(output).toContain('prerender_queue_wait_duration_seconds_bucket{le="0.01"} 1');
  });

  it('max concurrent/queued gauges reflect configuration', async () => {
    const metrics = createMetrics();
    controller = createCapacityController({
      maxConcurrent: 3,
      maxQueued: 7,
      queueTimeoutMs: 5000,
      metrics,
    });

    const output = await metrics.getMetrics();
    expect(gaugeValue(output, 'prerender_render_max_concurrent')).toBe(3);
    expect(gaugeValue(output, 'prerender_render_max_queued')).toBe(7);
  });

  it('gauges never go negative across many transitions', async () => {
    const metrics = createMetrics();
    controller = createCapacityController({
      maxConcurrent: 1,
      maxQueued: 3,
      queueTimeoutMs: 5000,
      metrics,
    });

    for (let i = 0; i < 5; i++) {
      await controller.run(async () => i).catch(() => undefined);
    }

    const output = await metrics.getMetrics();
    expect(gaugeValue(output, 'prerender_render_active')).toBeGreaterThanOrEqual(0);
    expect(gaugeValue(output, 'prerender_render_queued')).toBeGreaterThanOrEqual(0);
  });

  it('a metrics implementation that throws does not break capacity control', async () => {
    const throwingMetrics = createMetrics();
    const original = throwingMetrics.setCapacitySnapshot;
    throwingMetrics.setCapacitySnapshot = () => {
      throw new Error('boom from metrics');
    };
    void original;

    controller = createCapacityController({
      maxConcurrent: 1,
      maxQueued: 5,
      queueTimeoutMs: 5000,
      metrics: throwingMetrics,
    });

    // run() must still resolve normally even though metrics blows up.
    const result = await controller.run(async () => 'ok');
    expect(result).toBe('ok');
  });
});
