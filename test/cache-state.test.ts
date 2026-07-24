import { describe, expect, it } from 'vitest';
import { classifyCacheState, type CacheStateInput } from '../src/lib/cache-state.js';

const NOW = new Date('2026-07-24T12:00:00.000Z');
const BEFORE = new Date(NOW.getTime() - 1000);
const AFTER = new Date(NOW.getTime() + 1000);

describe('classifyCacheState', () => {
  it('classifies a null entry as miss', () => {
    expect(classifyCacheState(null, NOW)).toBe('miss');
  });

  it('classifies pending status as pending regardless of timestamps', () => {
    const entry: CacheStateInput = { status: 'pending', freshUntil: null, staleUntil: null };
    expect(classifyCacheState(entry, NOW)).toBe('pending');
  });

  it('classifies failed status as failed', () => {
    const entry: CacheStateInput = { status: 'failed', freshUntil: null, staleUntil: null };
    expect(classifyCacheState(entry, NOW)).toBe('failed');
  });

  it('classifies invalidated status as invalidated even if freshUntil is in the future', () => {
    const entry: CacheStateInput = { status: 'invalidated', freshUntil: AFTER, staleUntil: AFTER };
    expect(classifyCacheState(entry, NOW)).toBe('invalidated');
  });

  it('classifies ready + now < freshUntil as fresh', () => {
    const entry: CacheStateInput = { status: 'ready', freshUntil: AFTER, staleUntil: new Date(AFTER.getTime() + 1000) };
    expect(classifyCacheState(entry, NOW)).toBe('fresh');
  });

  it('classifies ready + now === freshUntil as stale (fresh boundary is exclusive)', () => {
    const entry: CacheStateInput = { status: 'ready', freshUntil: NOW, staleUntil: AFTER };
    expect(classifyCacheState(entry, NOW)).toBe('stale');
  });

  it('classifies ready + freshUntil <= now < staleUntil as stale', () => {
    const entry: CacheStateInput = { status: 'ready', freshUntil: BEFORE, staleUntil: AFTER };
    expect(classifyCacheState(entry, NOW)).toBe('stale');
  });

  it('classifies ready + now === staleUntil as expired (stale boundary is exclusive)', () => {
    const entry: CacheStateInput = { status: 'ready', freshUntil: BEFORE, staleUntil: NOW };
    expect(classifyCacheState(entry, NOW)).toBe('expired');
  });

  it('classifies ready + now >= staleUntil as expired', () => {
    const entry: CacheStateInput = { status: 'ready', freshUntil: BEFORE, staleUntil: BEFORE };
    expect(classifyCacheState(entry, NOW)).toBe('expired');
  });

  it('fails closed to expired if a ready row somehow has null freshUntil/staleUntil', () => {
    const entry: CacheStateInput = { status: 'ready', freshUntil: null, staleUntil: null };
    expect(classifyCacheState(entry, NOW)).toBe('expired');
  });

  it('uses the injected clock, not the real current time', () => {
    const farFuture = new Date('2099-01-01T00:00:00.000Z');
    const entry: CacheStateInput = { status: 'ready', freshUntil: farFuture, staleUntil: farFuture };
    expect(classifyCacheState(entry, NOW)).toBe('fresh');
  });
});
