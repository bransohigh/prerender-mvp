export class RenderQueueFullError extends Error {
  readonly code = 'RENDER_QUEUE_FULL' as const;
  constructor() {
    super('Render capacity is currently full. Please retry shortly.');
    this.name = 'RenderQueueFullError';
  }
}

export class RenderQueueTimeoutError extends Error {
  readonly code = 'RENDER_QUEUE_TIMEOUT' as const;
  constructor() {
    super('Render queue wait time exceeded. Please retry shortly.');
    this.name = 'RenderQueueTimeoutError';
  }
}

export class RenderCapacityClosedError extends Error {
  readonly code = 'RENDER_CAPACITY_CLOSED' as const;
  constructor() {
    super('Render service is shutting down.');
    this.name = 'RenderCapacityClosedError';
  }
}

export type CapacityError =
  | RenderQueueFullError
  | RenderQueueTimeoutError
  | RenderCapacityClosedError;

export function isCapacityError(err: unknown): err is CapacityError {
  return (
    err instanceof RenderQueueFullError ||
    err instanceof RenderQueueTimeoutError ||
    err instanceof RenderCapacityClosedError
  );
}
