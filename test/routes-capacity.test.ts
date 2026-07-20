import { describe, expect, it, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { RenderFn } from '../src/types/render.js';

const VALID_API_KEY = process.env['API_KEY'] ?? 'test-api-key-12345';

function makeRenderResult() {
  return {
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    statusCode: 200,
    title: 'Example',
    html: '<html><head><title>Example</title></head><body>Hello</body></html>',
    renderTimeMs: 42,
    renderedAt: new Date().toISOString(),
  };
}

function defer<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

function makeBlockingRenderUrl() {
  const blockers: Deferred[] = [];
  const fn: RenderFn = vi.fn(async () => {
    const d = defer() as unknown as Deferred;
    blockers.push(d);
    await d.promise;
    return makeRenderResult();
  });
  return { fn, blockers };
}

function postRender(app: Awaited<ReturnType<typeof buildApp>>, url = 'https://example.com') {
  return app.inject({
    method: 'POST',
    url: '/v1/render',
    headers: { 'x-api-key': VALID_API_KEY },
    payload: { url },
  });
}

describe('POST /v1/render kapasite kontrolleri', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  afterEach(async () => {
    await app?.close();
  });

  it('kapasite doluyken üçüncü istek sıraya alınır ve başarılı olur', async () => {
    const { fn, blockers } = makeBlockingRenderUrl();
    app = await buildApp({
      renderUrl: fn,
      maxConcurrentRenders: 2,
      maxQueuedRenders: 5,
      renderQueueTimeoutMs: 5000,
    });

    const p1 = postRender(app);
    const p2 = postRender(app);
    const p3 = postRender(app);

    // Wait for first two to start
    await vi.waitFor(() => expect(blockers).toHaveLength(2));

    // Resolve first blocker — third should start
    blockers[0]!.resolve();
    const r1 = await p1;
    expect(r1.statusCode).toBe(200);

    await vi.waitFor(() => expect(blockers).toHaveLength(3));
    blockers[1]!.resolve();
    blockers[2]!.resolve();

    const [r2, r3] = await Promise.all([p2, p3]);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(200);
  });

  it('queue doluyken sonraki istek 503 alır', async () => {
    const { fn, blockers } = makeBlockingRenderUrl();
    app = await buildApp({
      renderUrl: fn,
      maxConcurrentRenders: 1,
      maxQueuedRenders: 1,
      renderQueueTimeoutMs: 5000,
    });

    const p1 = postRender(app);
    await vi.waitFor(() => expect(blockers).toHaveLength(1));

    const p2 = postRender(app); // queued
    // Yield to let p2 enter the queue before p3 arrives
    await new Promise((r) => setTimeout(r, 20));
    const p3 = postRender(app); // should be rejected

    const r3 = await p3;
    expect(r3.statusCode).toBe(503);
    const body = JSON.parse(r3.payload) as { code: string; error: string; message: string };
    expect(body.code).toBe('RENDER_QUEUE_FULL');
    expect(body.error).toBe('service_unavailable');
    expect(body.message).toBeTruthy();

    blockers[0]!.resolve();
    await vi.waitFor(() => expect(blockers).toHaveLength(2));
    blockers[1]!.resolve();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
  });

  it('queue timeout olduğunda 503 ve doğru error code döner', async () => {
    const { fn, blockers } = makeBlockingRenderUrl();
    app = await buildApp({
      renderUrl: fn,
      maxConcurrentRenders: 1,
      maxQueuedRenders: 5,
      renderQueueTimeoutMs: 50,
    });

    const p1 = postRender(app);
    await vi.waitFor(() => expect(blockers).toHaveLength(1));

    const r2 = await postRender(app);
    expect(r2.statusCode).toBe(503);
    const body = JSON.parse(r2.payload) as { code: string };
    expect(body.code).toBe('RENDER_QUEUE_TIMEOUT');

    blockers[0]!.resolve();
    await p1;
  });

  it('503 cevabında Retry-After header bulunur', async () => {
    const { fn, blockers } = makeBlockingRenderUrl();
    app = await buildApp({
      renderUrl: fn,
      maxConcurrentRenders: 1,
      maxQueuedRenders: 0,
      renderQueueTimeoutMs: 5000,
    });

    const p1 = postRender(app);
    await vi.waitFor(() => expect(blockers).toHaveLength(1));

    const r2 = await postRender(app);
    expect(r2.statusCode).toBe(503);
    expect(r2.headers['retry-after']).toBe('5');

    blockers[0]!.resolve();
    await p1;
  });

  it('renderer hata verdiğinde slot serbest kalır ve sonraki istek çalışır', async () => {
    let callCount = 0;
    const errorRender: RenderFn = async () => {
      callCount++;
      if (callCount === 1) throw new Error('ilk render hata');
      return makeRenderResult();
    };

    app = await buildApp({
      renderUrl: errorRender,
      maxConcurrentRenders: 1,
      maxQueuedRenders: 5,
      renderQueueTimeoutMs: 5000,
    });

    const r1 = await postRender(app);
    expect(r1.statusCode).toBe(422);

    const r2 = await postRender(app);
    expect(r2.statusCode).toBe(200);
  });

  it('503 cevabı dahili hata ayrıntısı sızdırmaz', async () => {
    const { fn, blockers } = makeBlockingRenderUrl();
    app = await buildApp({
      renderUrl: fn,
      maxConcurrentRenders: 1,
      maxQueuedRenders: 0,
      renderQueueTimeoutMs: 5000,
    });

    const p1 = postRender(app);
    await vi.waitFor(() => expect(blockers).toHaveLength(1));

    const r2 = await postRender(app);
    expect(r2.payload).not.toContain('at ');
    expect(r2.payload).not.toContain('node_modules');
    expect(r2.payload).not.toContain('queue');
    expect(r2.payload).not.toContain('active');

    blockers[0]!.resolve();
    await p1;
  });
});
