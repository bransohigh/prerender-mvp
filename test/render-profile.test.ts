import { describe, expect, it } from 'vitest';
import { computeRenderProfileHash, RENDER_PROFILE_VERSION } from '../src/lib/render-profile.js';

describe('computeRenderProfileHash', () => {
  it('is deterministic for identical input', () => {
    const input = { waitStrategy: 'load', timeoutProfile: 'fast' };
    expect(computeRenderProfileHash(input)).toBe(computeRenderProfileHash({ ...input }));
  });

  it('produces a 64-char lowercase hex digest', () => {
    expect(computeRenderProfileHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of input property key order', () => {
    const a = computeRenderProfileHash({ waitStrategy: 'load', javascriptEnabled: false });
    const b = computeRenderProfileHash({ javascriptEnabled: false, waitStrategy: 'load' });
    expect(a).toBe(b);
  });

  it('produces the same hash for an empty input and the documented defaults', () => {
    const a = computeRenderProfileHash();
    const b = computeRenderProfileHash({
      waitStrategy: 'networkidle',
      timeoutProfile: 'default',
      userAgentProfile: 'default',
      javascriptEnabled: true,
      resourceBlockingProfile: 'default',
    });
    expect(a).toBe(b);
  });

  it('changes when waitStrategy changes', () => {
    expect(computeRenderProfileHash({ waitStrategy: 'load' })).not.toBe(computeRenderProfileHash({ waitStrategy: 'networkidle' }));
  });

  it('changes when javascriptEnabled changes', () => {
    expect(computeRenderProfileHash({ javascriptEnabled: true })).not.toBe(computeRenderProfileHash({ javascriptEnabled: false }));
  });

  it('changes when resourceBlockingProfile changes', () => {
    expect(computeRenderProfileHash({ resourceBlockingProfile: 'default' })).not.toBe(
      computeRenderProfileHash({ resourceBlockingProfile: 'aggressive' }),
    );
  });

  it('ignores properties outside the allowlisted RenderProfileInput shape', () => {
    const extraInput = { waitStrategy: 'load', requestId: 'abc123' } as unknown as Parameters<typeof computeRenderProfileHash>[0];
    const withExtra = computeRenderProfileHash(extraInput);
    const withoutExtra = computeRenderProfileHash({ waitStrategy: 'load' });
    expect(withExtra).toBe(withoutExtra);
  });

  it('is pinned to the current RENDER_PROFILE_VERSION', () => {
    expect(RENDER_PROFILE_VERSION).toBe(1);
  });
});
