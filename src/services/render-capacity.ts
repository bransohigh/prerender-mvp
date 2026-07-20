import {
  RenderQueueFullError,
  RenderQueueTimeoutError,
  RenderCapacityClosedError,
} from '../lib/errors.js';

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
}

interface QueueEntry<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cancelled: boolean;
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
  let active = 0;
  let closed = false;
  const queue: QueueEntry<unknown>[] = [];

  function tryRunNext(): void {
    while (active < maxConcurrent && queue.length > 0) {
      const entry = queue.shift()!;
      clearTimeout(entry.timer);
      if (entry.cancelled) continue;
      executeEntry(entry);
    }
  }

  function executeEntry<T>(entry: QueueEntry<T>): void {
    active++;
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
        };
        clearTimeout(entry.timer);
        executeEntry(entry);
      });
    }

    if (queue.length >= maxQueued) {
      return Promise.reject(new RenderQueueFullError());
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.cancelled = true;
        const idx = queue.indexOf(entry as QueueEntry<unknown>);
        if (idx !== -1) queue.splice(idx, 1);
        reject(new RenderQueueTimeoutError());
      }, queueTimeoutMs);

      const entry: QueueEntry<T> = {
        task,
        resolve,
        reject,
        timer,
        cancelled: false,
      };

      queue.push(entry as QueueEntry<unknown>);
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

  return { run, close, getSnapshot };
}
