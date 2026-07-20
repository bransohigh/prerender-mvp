import { chromium, type Browser, type LaunchOptions } from 'playwright';

export interface BrowserLaunchConfig {
  proxyUrl?: string;
  sandbox?: boolean;
  // Fail fast if running on Linux without the Chromium sandbox enabled.
  // Only the production renderer sets this — integration tests intentionally
  // launch without Playwright's sandbox on bare (non-Docker) CI runners where
  // unprivileged user namespaces may be restricted by the host, since the
  // hardened container's own isolation (seccomp, cap_drop ALL, etc.) does
  // not apply there anyway.
  enforceSandboxOnLinux?: boolean;
}

export function buildLaunchOptions(config?: BrowserLaunchConfig): LaunchOptions {
  const args = [
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--no-first-run',
  ];

  const options: LaunchOptions = {
    headless: true,
    args,
  };

  if (config?.sandbox === true) {
    options.chromiumSandbox = true;
  }

  if (config?.proxyUrl) {
    options.proxy = { server: config.proxyUrl };
  }

  return options;
}

export function assertNoSandboxBypass(options: LaunchOptions): void {
  const forbidden = ['--no-sandbox', '--disable-setuid-sandbox'];
  for (const flag of forbidden) {
    if (options.args?.includes(flag)) {
      throw new Error(`Forbidden Chromium flag detected: ${flag}`);
    }
  }
}

export function assertSandboxRequiredOnLinux(options: LaunchOptions): void {
  if (process.platform === 'linux' && options.chromiumSandbox !== true) {
    throw new Error(
      'Chromium sandbox is required on Linux and must not be disabled.',
    );
  }
}

export function createDefaultLauncher(
  config?: BrowserLaunchConfig,
): () => Promise<Browser> {
  const options = buildLaunchOptions(config);
  assertNoSandboxBypass(options);
  if (config?.enforceSandboxOnLinux) {
    assertSandboxRequiredOnLinux(options);
  }
  return () => chromium.launch(options);
}
