import type { RenderFn, RenderResult } from '../types/render.js';
import type { RenderCapacityController } from './render-capacity.js';

export interface RenderService {
  renderUrl: RenderFn;
  close: () => void;
  getSnapshot: RenderCapacityController['getSnapshot'];
}

export function createRenderService(
  renderer: RenderFn,
  capacity: RenderCapacityController,
): RenderService {
  function renderUrl(rawUrl: string): Promise<RenderResult> {
    return capacity.run(() => renderer(rawUrl));
  }

  return {
    renderUrl,
    close: () => capacity.close(),
    getSnapshot: () => capacity.getSnapshot(),
  };
}
