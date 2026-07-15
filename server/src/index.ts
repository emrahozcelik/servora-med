import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { closeDatabase, createDatabase } from './db/index.js';
import { createPostgresReadiness } from './modules/health/postgres-readiness.js';
import { PostgresAuthRepository } from './modules/auth/repository.js';
import { PostgresJobCardRepository } from './modules/job-cards/repository.js';
import {
  AuthCredentialAdministration,
  PostgresSessionRevocationPort,
} from './modules/auth/admin-ports.js';
import { PostgresPeopleRepository } from './modules/people/repository.js';
import { PostgresCustomerAssignmentCleanup } from './modules/crm/people-adapter.js';
import { PostgresCrmRepository } from './modules/crm/repository.js';
import { PostgresProductRepository } from './modules/products/repository.js';
import { PostgresReportsRepository } from './modules/reports/repository.js';
import { createShutdown } from './shutdown.js';

async function main() {
  const config = loadConfig();
  const database = createDatabase(config.databaseUrl);
  const credentials = new AuthCredentialAdministration();
  const sessions = new PostgresSessionRevocationPort();
  const customerAssignments = new PostgresCustomerAssignmentCleanup();
  const jobCards = new PostgresJobCardRepository(database.pool);
  const reports = new PostgresReportsRepository(database.pool);
  const app = await buildApp(config, {
    authRepository: new PostgresAuthRepository(database.pool),
    jobCardRepository: jobCards,
    peopleRepository: new PostgresPeopleRepository(
      database.pool, credentials, sessions, customerAssignments,
    ),
    crmRepository: new PostgresCrmRepository(database.pool),
    productRepository: new PostgresProductRepository(database.pool),
    approvalQueueItemPort: jobCards,
    reportsRepository: reports,
    healthReadiness: createPostgresReadiness(database.pool, config.healthSchemaVersion),
  });

  const shutdown = createShutdown({
    closeApp: () => app.close(),
    closeDb: () => closeDatabase(database),
    log: (message, fields) => app.log.info(fields ?? {}, message),
    exit: (code) => {
      process.exitCode = code;
      if (code !== 0) process.exit(code);
    },
  });

  process.once('SIGINT', () => {
    void shutdown('SIGINT').catch((error) => {
      app.log.error({ err: error }, 'Shutdown handler failed');
      process.exit(1);
    });
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').catch((error) => {
      app.log.error({ err: error }, 'Shutdown handler failed');
      process.exit(1);
    });
  });

  try {
    // Migrations are applied only via migrate / migrate:prod — never on process start.
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error({ err: error }, 'Server startup failed');
    await app.close();
    await closeDatabase(database);
    process.exitCode = 1;
  }
}

await main();
