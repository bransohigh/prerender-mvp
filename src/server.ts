import { buildApp } from './app.js';
import { env } from './config/env.js';
import { closeRenderer } from './services/renderer.js';

if (env.REQUIRE_OUTBOUND_PROXY && !env.OUTBOUND_PROXY_URL) {
  console.error(
    'FATAL: REQUIRE_OUTBOUND_PROXY=true but OUTBOUND_PROXY_URL is not set. ' +
      'Refusing to start without egress proxy in hardened mode.',
  );
  process.exit(1);
}

const app = await buildApp();

const shutdown = async (signal: string) => {
  app.log.info({ event: 'shutdown_start', signal }, 'Sunucu kapatılıyor');
  app.markShuttingDown();
  await app.close();
  await closeRenderer();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
