import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildLaunchOptions,
  assertNoSandboxBypass,
  assertSandboxRequiredOnLinux,
  createDefaultLauncher,
} from '../src/lib/browser-launch.js';

describe('buildLaunchOptions', () => {
  it('sandbox=true sets chromiumSandbox', () => {
    const opts = buildLaunchOptions({ sandbox: true });
    expect(opts.chromiumSandbox).toBe(true);
  });

  it('sandbox unset does not set chromiumSandbox', () => {
    const opts = buildLaunchOptions();
    expect(opts.chromiumSandbox).toBeUndefined();
  });

  it('proxyUrl sets proxy.server', () => {
    const opts = buildLaunchOptions({ proxyUrl: 'http://proxy:3128' });
    expect(opts.proxy).toEqual({ server: 'http://proxy:3128' });
  });

  it('no proxyUrl means no proxy field', () => {
    const opts = buildLaunchOptions();
    expect(opts.proxy).toBeUndefined();
  });

  it('headless is always true', () => {
    const opts = buildLaunchOptions();
    expect(opts.headless).toBe(true);
  });

  it('does not include --no-sandbox', () => {
    const opts = buildLaunchOptions({ sandbox: true });
    expect(opts.args).not.toContain('--no-sandbox');
    expect(opts.args).not.toContain('--disable-setuid-sandbox');
  });
});

describe('assertNoSandboxBypass', () => {
  it('throws on --no-sandbox', () => {
    expect(() =>
      assertNoSandboxBypass({ args: ['--no-sandbox'] }),
    ).toThrow('Forbidden Chromium flag');
  });

  it('throws on --disable-setuid-sandbox', () => {
    expect(() =>
      assertNoSandboxBypass({ args: ['--disable-setuid-sandbox'] }),
    ).toThrow('Forbidden Chromium flag');
  });

  it('passes with safe args', () => {
    expect(() =>
      assertNoSandboxBypass({ args: ['--disable-dev-shm-usage'] }),
    ).not.toThrow();
  });

  it('passes with no args', () => {
    expect(() => assertNoSandboxBypass({})).not.toThrow();
  });
});

describe('assertSandboxRequiredOnLinux', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('throws on Linux when chromiumSandbox is not true', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(() => assertSandboxRequiredOnLinux({})).toThrow(
      'Chromium sandbox is required on Linux',
    );
  });

  it('does not throw on Linux when chromiumSandbox is true', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(() =>
      assertSandboxRequiredOnLinux({ chromiumSandbox: true }),
    ).not.toThrow();
  });

  it('does not throw on non-Linux platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(() => assertSandboxRequiredOnLinux({})).not.toThrow();
  });
});

describe('createDefaultLauncher', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.restoreAllMocks();
  });

  it('does not enforce sandbox by default (test/local usage)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(() => createDefaultLauncher()).not.toThrow();
  });

  it('fails fast when enforceSandboxOnLinux is set but sandbox is off', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(() =>
      createDefaultLauncher({ enforceSandboxOnLinux: true }),
    ).toThrow('Chromium sandbox is required on Linux');
  });

  it('succeeds when enforceSandboxOnLinux is set and sandbox is on', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(() =>
      createDefaultLauncher({ sandbox: true, enforceSandboxOnLinux: true }),
    ).not.toThrow();
  });
});
