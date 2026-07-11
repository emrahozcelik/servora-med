import { fileURLToPath } from 'node:url';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { closeDatabase, createDatabase } from './db/index.js';
import { runMigrations } from './db/migrate-runner.js';
import { PostgresAuthRepository } from './modules/auth/repository.js';
import { PostgresJobCardRepository } from './modules/job-cards/repository.js';

async function main() {
  const config = loadConfig();
  const database = createDatabase(config.databaseUrl);
  const app = await buildApp(config, {
    authRepository: new PostgresAuthRepository(database.pool),
    jobCardRepository: new PostgresJobCardRepository(database.pool),
  });
  const migrationsDirectory = fileURLToPath(new URL('./db/migrations/', import.meta.url));
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    await closeDatabase(database);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await runMigrations({
      migrationsDirectory,
      store: database.migrations,
      logger: app.log,
    });
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error({ err: error }, 'Server startup failed');
    await app.close();
    await closeDatabase(database);
    process.exitCode = 1;
  }
}

await main();
