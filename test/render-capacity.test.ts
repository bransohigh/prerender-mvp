import { describe, expect, it, afterEach } from 'vitest';
import {
  createCapacityController,
  type RenderCapacityController,
} from '../src/services/render-capacity.js';
import {
  RenderQueueFullError,
  RenderQueueTimeoutError,
  RenderCapacityClosedError,
} from '../src/lib/errors.js';

function defer<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let controller: RenderCapacityController | null = null;

afterEach(() => {
  controller?.close();
  controller = null;
});

describe('RenderCapacityController', () => {
  describe('eşzamanlılık sınırı', () => {
    it('maxConcurrent=2 iken aynı anda en fazla 2 task aktif olur', async () => {
      controller = createCapacityController({
        maxConcurrent: 2,
        maxQueued: 10,
        queueTimeoutMs: 5000,
      });

      const d1 = defer();
      const d2 = defer();
      const d3 = defer();

      const p1 = controller.run(() => d1.promise);
      const p2 = controller.run(() => d2.promise);
      const p3 = controller.run(() => d3.promise);

      // Wait a tick for scheduling
      await Promise.resolve();

      expect(controller.getSnapshot().active).toBe(2);
      expect(controller.getSnapshot().queued).toBe(1);

      d1.resolve();
      await p1;
      await Promise.resolve();

      expect(controller.getSnapshot().active).toBe(2);
      expect(controller.getSnapshot().queued).toBe(0);

      d2.resolve();
      d3.resolve();
      await Promise.all([p2, p3]);

      expect(controller.getSnapshot().active).toBe(0);
      expect(controller.getSnapshot().queued).toBe(0);
    });

    it('ilk iki task hemen çalışır, üçüncü sıraya girer', async () => {
      controller = createCapacityController({
        maxConcurrent: 2,
        maxQueued: 10,
        queueTimeoutMs: 5000,
      });

      const order: number[] = [];
      const d1 = defer();
      const d2 = defer();

      controller.run(async () => {
        await d1.promise;
        order.push(1);
      });
      controller.run(async () => {
        await d2.promise;
        order.push(2);
      });
      const p3 = controller.run(async () => {
        order.push(3);
      });

      await Promise.resolve();
      expect(controller.getSnapshot().active).toBe(2);

      d1.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await p3;
      d2.resolve();

      expect(order[0]).toBe(1);
      expect(order[1]).toBe(3);
    });
  });

  describe('FIFO sıralaması', () => {
    it('bekleyen taskler kuyruğa giriş sırasına göre başlar', async () => {
      controller = createCapacityController({
        maxConcurrent: 1,
        maxQueued: 5,
        queueTimeoutMs: 5000,
      });

      const order: string[] = [];
      const blocker = defer();

      const pBlock = controller.run(() => blocker.promise);
      const pA = controller.run(async () => {
        order.push('A');
      });
      const pB = controller.run(async () => {
        order.push('B');
      });
      const pC = controller.run(async () => {
        order.push('C');
      });

      blocker.resolve();
      await Promise.all([pBlock, pA, pB, pC]);

      expect(order).toEqual(['A', 'B', 'C']);
    });
  });

  describe('queue full', () => {
    it('maxQueued aşıldığında RenderQueueFullError fırlatır', async () => {
      controller = createCapacityController({
        maxConcurrent: 1,
        maxQueued: 2,
        queueTimeoutMs: 5000,
      });

      const blocker = defer();
      controller.run(() => blocker.promise);

      // Fill queue
      controller.run(async () => {});
      controller.run(async () => {});

      await expect(controller.run(async () => {})).rejects.toBeInstanceOf(
        RenderQueueFullError,
      );

      expect(controller.getSnapshot().queued).toBe(2);

      blocker.resolve();
    });

    it('reddedilen task hiçbir zaman çalışmaz', async () => {
      controller = createCapacityController({
        maxConcurrent: 1,
        maxQueued: 0,
        queueTimeoutMs: 5000,
      });

      const blocker = defer();
      controller.run(() => blocker.promise);

      let ran = false;
      await expect(
        controller.run(async () => {
          ran = true;
        }),
      ).rejects.toBeInstanceOf(RenderQueueFullError);

      blocker.resolve();
      await Promise.resolve();
      expect(ran).toBe(false);
    });
  });

  describe('queue timeout', () => {
    it('kuyrukta süre aşılınca RenderQueueTimeoutError fırlatır', async () => {
      controller = createCapacityController({
        maxConcurrent: 1,
        maxQueued: 5,
        queueTimeoutMs: 50,
      });

      const blocker = defer();
      controller.run(() => blocker.promise);

      await expect(
        controller.run(async () => {}),
      ).rejects.toBeInstanceOf(RenderQueueTimeoutError);

      blocker.resolve();
    });

    it('timeout olan task slot boşalsa bile çalışmaz', async () => {
      controller = createCapacityController({
        maxConcurrent: 1,
        maxQueued: 5,
        queueTimeoutMs: 50,
      });

      const blocker = defer();
      controller.run(() => blocker.promise);

      let ran = false;
      await expect(
        controller.run(async () => {
          ran = true;
        }),
      ).rejects.toBeInstanceOf(RenderQueueTimeoutError);

      blocker.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(ran).toBe(false);
    });
  });

  describe('slot release', () => {
    it('başarılı task sonrası slot serbest bırakılır', async () => {
      controller = createCapacityController({
        maxConcurrent: 1,
        maxQueued: 5,
        queueTimeoutMs: 5000,
      });

      await controller.run(async () => 'done');
      expect(controller.getSnapshot().active).toBe(0);
    });

    it('hata atan task sonrası slot serbest bırakılır', async () => {
      controller = createCapacityController({
        maxConcurrent: 1,
        maxQueued: 5,
        queueTimeoutMs: 5000,
      });

      await expect(
        controller.run(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(controller.getSnapshot().active).toBe(0);

      const result = await controller.run(async () => 'ok');
      expect(result).toBe('ok');
    });

    it('reject olan task sonraki queued taskı engellemez', async () => {
      controller = createCapacityController({
        maxConcurrent: 1,
        maxQueued: 5,
        queueTimeoutMs: 5000,
      });

      const blocker = defer();
      const p1 = controller.run(async () => {
        await blocker.promise;
        throw new Error('fail');
      });
      const p2 = controller.run(async () => 'second');

      blocker.resolve();
      await expect(p1).rejects.toThrow('fail');
      await expect(p2).resolves.toBe('second');
    });
  });

  describe('close', () => {
    it('close sonrasında yeni task reddedilir', () => {
      controller = createCapacityController({
        maxConcurrent: 2,
        maxQueued: 5,
        queueTimeoutMs: 5000,
      });

      controller.close();

      expect(controller.run(async () => {})).rejects.toBeInstanceOf(
        RenderCapacityClosedError,
      );
    });

    it('kuyruktaki taskler RenderCapacityClosedError alır', async () => {
      controller = createCapacityController({
        maxConcurrent: 1,
        maxQueued: 5,
        queueTimeoutMs: 5000,
      });

      const blocker = defer();
      controller.run(() => blocker.promise);

      const p2 = controller.run(async () => {});
      const p3 = controller.run(async () => {});

      controller.close();

      await expect(p2).rejects.toBeInstanceOf(RenderCapacityClosedError);
      await expect(p3).rejects.toBeInstanceOf(RenderCapacityClosedError);

      blocker.resolve();
    });

    it('active ve queued negatif olmaz', async () => {
      controller = createCapacityController({
        maxConcurrent: 1,
        maxQueued: 5,
        queueTimeoutMs: 5000,
      });

      const blocker = defer();
      const p1 = controller.run(() => blocker.promise);

      controller.close();
      blocker.resolve();
      await p1;

      const snap = controller.getSnapshot();
      expect(snap.active).toBeGreaterThanOrEqual(0);
      expect(snap.queued).toBeGreaterThanOrEqual(0);
      expect(snap.closed).toBe(true);
    });

    it('close idempotent', () => {
      controller = createCapacityController({
        maxConcurrent: 1,
        maxQueued: 5,
        queueTimeoutMs: 5000,
      });

      controller.close();
      controller.close();
      expect(controller.getSnapshot().closed).toBe(true);
    });
  });

  describe('snapshot', () => {
    it('her aşamada doğru değerler döner', async () => {
      controller = createCapacityController({
        maxConcurrent: 1,
        maxQueued: 5,
        queueTimeoutMs: 5000,
      });

      expect(controller.getSnapshot()).toEqual({
        active: 0,
        queued: 0,
        maxConcurrent: 1,
        maxQueued: 5,
        closed: false,
      });

      const d1 = defer();
      controller.run(() => d1.promise);
      await Promise.resolve();

      expect(controller.getSnapshot().active).toBe(1);
      expect(controller.getSnapshot().queued).toBe(0);

      controller.run(async () => {});
      expect(controller.getSnapshot().queued).toBe(1);

      d1.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(controller.getSnapshot().active).toBe(0);
      expect(controller.getSnapshot().queued).toBe(0);
    });
  });
});
