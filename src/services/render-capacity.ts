import {
  RenderQueueFullError,
  RenderQueueTimeoutError,
  RenderCapacityClosedError,
} from '../lib/errors.js';
import { createNoopMetrics, safeMetricsCall, type Metrics } from '../lib/metrics.js';

export interface CapacitySnapshot {
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
  closed: boolean;
}

export interface RenderCapacityOptions {
  maxConcurrent: number;
  maxQueued: number;
  queueTimeoutMs: number;
  metrics?: Metrics;
}

interface QueueEntry<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  enqueuedAt: number;
}

export interface RenderCapacityController {
  run: <T>(task: () => Promise<T>) => Promise<T>;
  close: () => void;
  getSnapshot: () => CapacitySnapshot;
}

export function createCapacityController(
  options: RenderCapacityOptions,
): RenderCapacityController {
  const { maxConcurrent, maxQueued, queueTimeoutMs } = options;
  const metrics = options.metrics ?? createNoopMetrics();
  let active = 0;
  let closed = false;
  const queue: QueueEntry<unknown>[] = [];

  function reportSnapshot(): void {
    safeMetricsCall(() =>
      metrics.setCapacitySnapshot({
        active,
        queued: queue.length,
        maxConcurrent,
        maxQueued,
      }),
    );
  }

  function tryRunNext(): void {
    while (active < maxConcurrent && queue.length > 0) {
      const entry = queue.shift()!;
      clearTimeout(entry.timer);
      if (entry.cancelled) continue;
      executeEntry(entry);
    }
    reportSnapshot();
  }

  function executeEntry<T>(entry: QueueEntry<T>): void {
    active++;
    const waitSeconds = Math.max(0, Date.now() - entry.enqueuedAt) / 1000;
    safeMetricsCall(() => metrics.observeQueueWait(waitSeconds));
    reportSnapshot();
    let released = false;

    function releaseSlot(): void {
      if (released) return;
      released = true;
      active--;
      tryRunNext();
    }

    entry
      .task()
      .then((value) => {
        releaseSlot();
        entry.resolve(value);
      })
      .catch((err: unknown) => {
        releaseSlot();
        entry.reject(err);
      });
  }

  function run<T>(task: () => Promise<T>): Promise<T> {
    if (closed) {
      return Promise.reject(new RenderCapacityClosedError());
    }

    if (active < maxConcurrent) {
      return new Promise<T>((resolve, reject) => {
        const entry: QueueEntry<T> = {
          task,
          resolve,
          reject,
          timer: setTimeout(() => {}, 0),
          cancelled: false,
          enqueuedAt: Date.now(),
        };
        clearTimeout(entry.timer);
        executeEntry(entry);
      });
    }

    if (queue.length >= maxQueued) {
      return Promise.reject(new RenderQueueFullError());
    }

    return new Promise<T>((resolve, reject) => {
      const enqueuedAt = Date.now();
      const timer = setTimeout(() => {
        entry.cancelled = true;
        const idx = queue.indexOf(entry as QueueEntry<unknown>);
        if (idx !== -1) queue.splice(idx, 1);
        safeMetricsCall(() =>
          metrics.observeQueueWait(Math.max(0, Date.now() - enqueuedAt) / 1000),
        );
        reportSnapshot();
        reject(new RenderQueueTimeoutError());
      }, queueTimeoutMs);

      const entry: QueueEntry<T> = {
        task,
        resolve,
        reject,
        timer,
        cancelled: false,
        enqueuedAt,
      };

      queue.push(entry as QueueEntry<unknown>);
      reportSnapshot();
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    const pending = queue.splice(0, queue.length);
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.cancelled = true;
      entry.reject(new RenderCapacityClosedError());
    }
    reportSnapshot();
  }

  function getSnapshot(): CapacitySnapshot {
    return {
      active,
      queued: queue.length,
      maxConcurrent,
      maxQueued,
      closed,
    };
  }

  reportSnapshot();

  return { run, close, getSnapshot };
}
