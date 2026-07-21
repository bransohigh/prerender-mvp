import { describe, expect, it } from 'vitest';
import { normalizeSlug, slugFromName, isValidSlug } from '../src/lib/slug.js';

describe('normalizeSlug', () => {
  it('lowercases', () => {
    expect(normalizeSlug('MyProject')).toBe('myproject');
  });

  it('replaces spaces with hyphens', () => {
    expect(normalizeSlug('My Cool Project')).toBe('my-cool-project');
  });

  it('collapses multiple separators', () => {
    expect(normalizeSlug('a---b   c')).toBe('a-b-c');
  });

  it('strips leading/trailing hyphens', () => {
    expect(normalizeSlug('-hello-')).toBe('hello');
  });

  it('removes unsafe characters', () => {
    expect(normalizeSlug('Hello@World!.com')).toBe('hello-world-com');
  });

  it('truncates to max length', () => {
    const long = 'a'.repeat(200);
    expect(normalizeSlug(long).length).toBeLessThanOrEqual(63);
  });
});

describe('slugFromName', () => {
  it('falls back to "project" for an all-symbol name', () => {
    expect(slugFromName('!!!')).toBe('project');
  });

  it('derives a slug from a normal name', () => {
    expect(slugFromName('Example Project')).toBe('example-project');
  });
});

describe('isValidSlug', () => {
  it.each(['example', 'my-project', 'a1', 'a-1-b'])('accepts valid slug: %s', (slug) => {
    expect(isValidSlug(slug)).toBe(true);
  });

  it.each(['Example', 'has_underscore', '-leading', 'trailing-', 'a'.repeat(70), ''])(
    'rejects invalid slug: %s',
    (slug) => {
      expect(isValidSlug(slug)).toBe(false);
    },
  );
});
