import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDb, disconnectDb } from './db/connect.js';
import { startReleaseJob } from './jobs/release.js';
import { logger } from './lib/logger.js';
import { seedIfEmpty } from './seed/seed.js';

async function main() {
  await connectDb();
  if (env.SEED_ON_BOOT) await seedIfEmpty();
  const stopJob = startReleaseJob();

  const server = createApp().listen(env.PORT, () => {
    logger.info('Core Asana Partners API running', { port: env.PORT, demoTools: env.DEMO_TOOLS });
  });

  const shutdown = (signal: string) => {
    logger.info('Shutting down', { signal });
    stopJob();
    server.close(() => {
      void disconnectDb().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Failed to start', { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
