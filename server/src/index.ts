import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { closeDatabase, createDatabase } from './db/index.js';
import { createPostgresReadiness } from './modules/health/postgres-readiness.js';
import {
  assertStartupSchemaCompatible,
  getMigrationsDirectory,
} from './db/schema-compatibility.js';
import { loadMigrationCatalog } from './db/migration-catalog.js';
import { createPostgresBackupHealth } from './modules/health/postgres-backup-health.js';
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
import { PostgresWebPushRepository } from './modules/web-push/repository.js';
import { createProductionAppDependencies } from './app-dependencies.js';
import { PostgresOverviewRepository } from './modules/overview/repository.js';
import { PostgresCalendarRepository } from './modules/calendar/repository.js';
import { PostgresStaffConfidentialNotesRepository } from './modules/staff-confidential-notes/repository.js';
import {
  PostgresCalendarReminderWorkerRepository,
  createCalendarReminderWorker,
} from './modules/calendar/reminder-worker.js';

async function main() {
  const config = loadConfig();
  const database = createDatabase(config.databaseUrl);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let listening = false;

  try {
    // SD2: migration catalog is the sole authoritative expected history.
    // Do NOT use HEALTH_SCHEMA_VERSION as source; it is only an optional config assertion.
    const migrationsDirectory = getMigrationsDirectory();
    let catalog;
    try {
      catalog = await loadMigrationCatalog(migrationsDirectory);
    } catch (error) {
      console.error('Application migration catalog is invalid or unavailable', error);
      throw error;
    }
    if (!catalog.head || catalog.count === 0) {
      const error = new Error('Application migration catalog is empty or unavailable');
      console.error(error.message, { directory: migrationsDirectory });
      throw error;
    }
    if (config.healthSchemaVersion && config.healthSchemaVersion !== catalog.head.version) {
      const error = new Error(
        `HEALTH_SCHEMA_VERSION mismatch: expected ${catalog.head.version} but got ${config.healthSchemaVersion}`,
      );
      console.error(error.message);
      throw error;
    }

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

    const appDependencies = createProductionAppDependencies(config, database.pool, {
      authRepository: new PostgresAuthRepository(database.pool),
      jobCardRepository: jobCards,
      jobHistoryReadPort: jobCards,
      peopleRepository: new PostgresPeopleRepository(
        database.pool, credentials, sessions, customerAssignments,
      ),
      crmRepository: new PostgresCrmRepository(database.pool),
      productRepository: new PostgresProductRepository(database.pool),
      approvalQueueItemPort: jobCards,
      reportsRepository: reports,
      overviewRepository: new PostgresOverviewRepository(database.pool, reports),
      calendarRepository: new PostgresCalendarRepository(
        database.pool,
        config.calendarReminderLeadMinutes ?? 30,
        config.webPush.enabled,
      ),
      calendarReminderWorker: createCalendarReminderWorker(
        new PostgresCalendarReminderWorkerRepository(database.pool),
        {
          publisher: realtimeBus,
          webPushEnabled: config.webPush.enabled,
        },
      ),
      staffConfidentialNotesRepository: new PostgresStaffConfidentialNotesRepository(
        database.pool,
      ),
      healthReadiness: createPostgresReadiness(database.pool, catalog),
      backupHealthReadiness: createPostgresBackupHealth(database.pool, {
        workerEnabled: config.backupWorker?.enabled === true,
      }),
      realtimeService,
      realtimePublisher: realtimeBus,
      notificationRepository: new PostgresNotificationRepository(database.pool),
      webPushRepository: new PostgresWebPushRepository(database.pool),
      pool: database.pool,
    });
    app = await buildApp(config, appDependencies);

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

    // SD2: startup fail-fast — only COMPATIBLE may proceed to listen.
    await assertStartupSchemaCompatible({ pool: database.pool, catalog, logger: app.log });

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
