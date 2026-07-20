import { chromium, type Browser, type LaunchOptions } from 'playwright';

export interface BrowserLaunchConfig {
  proxyUrl?: string;
  sandbox?: boolean;
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

export function createDefaultLauncher(
  config?: BrowserLaunchConfig,
): () => Promise<Browser> {
  const options = buildLaunchOptions(config);
  assertNoSandboxBypass(options);
  return () => chromium.launch(options);
}
