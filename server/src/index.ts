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
import { InMemoryRealtimeEventBus } from './modules/realtime/event-bus.js';
import { PostgresRealtimeEventRepository } from './modules/realtime/repository.js';
import { RealtimeService } from './modules/realtime/service.js';
import { PostgresNotificationRepository } from './modules/notifications/repository.js';
import { createShutdown } from './shutdown.js';

async function main() {
  const config = loadConfig();
  const database = createDatabase(config.databaseUrl);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let listening = false;

  try {
    const credentials = new AuthCredentialAdministration();
    const sessions = new PostgresSessionRevocationPort();
    const customerAssignments = new PostgresCustomerAssignmentCleanup();
    const jobCards = new PostgresJobCardRepository(database.pool);
    const reports = new PostgresReportsRepository(database.pool);
    const realtimeBus = new InMemoryRealtimeEventBus((error) => {
      app?.log.error({ err: error }, 'Realtime subscriber failed');
    });
    const realtimeRepository = new PostgresRealtimeEventRepository(
      database.pool,
    );
    const realtimeService = new RealtimeService(
      realtimeRepository,
      realtimeBus,
    );
    app = await buildApp(config, {
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
      realtimeService,
      realtimePublisher: realtimeBus,
      notificationRepository: new PostgresNotificationRepository(database.pool),
    });

    const shutdown = createShutdown({
      closeApp: () => app!.close(),
      closeDb: () => closeDatabase(database),
      log: (message, fields) => app!.log.info(fields ?? {}, message),
      exit: (code) => {
        process.exitCode = code;
        if (code !== 0) process.exit(code);
      },
    });

    process.once('SIGINT', () => {
      void shutdown('SIGINT').catch((error) => {
        app?.log.error({ err: error }, 'Shutdown handler failed');
        process.exit(1);
      });
    });
    process.once('SIGTERM', () => {
      void shutdown('SIGTERM').catch((error) => {
        app?.log.error({ err: error }, 'Shutdown handler failed');
        process.exit(1);
      });
    });

    // Migrations are applied only via migrate / migrate:prod — never on process start.
    await app.listen({ host: config.host, port: config.port });
    listening = true;
  } catch (error) {
    if (app) {
      app.log.error({ err: error }, 'Server startup failed');
    } else {
      console.error('Server startup failed', error);
    }
    process.exitCode = 1;
  } finally {
    if (!listening) {
      try {
        await app?.close();
      } catch {
        // best-effort
      }
      try {
        await closeDatabase(database);
      } catch {
        // best-effort
      }
    }
  }
}

await main();
