import { buildApp } from './app.js';
import { DEFAULT_BACKUP_PROVIDER, loadConfig, type AppConfig } from './config.js';
import { closeDatabase, createDatabase } from './db/index.js';
import { createPostgresReadiness } from './modules/health/postgres-readiness.js';
import {
  assertStartupSchemaCompatible,
  getMigrationsDirectory,
} from './db/schema-compatibility.js';
import { loadMigrationCatalog } from './db/migration-catalog.js';
import { createPostgresBackupHealth } from './modules/health/postgres-backup-health.js';
import {
  createDisabledBackupHealth,
  createHostBackupObservationHealth,
} from './modules/health/host-backup-observation.js';
import type { BackupHealthReadinessPort } from './modules/health/service.js';
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
import { PostgresReportReadSnapshot } from './modules/reports/read-snapshot.js';
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
import {
  PostgresOverdueBreachScannerRepository,
  createOverdueBreachScanner,
} from './modules/job-cards/overdue-breach-scanner.js';

/**
 * Selects exactly one backup observability provider (DECISIONS.md -> OPS-004
 * item 9). Both providers are projected onto the shared public health contract,
 * so BR5/R2 and the host observation artifact can coexist later without being
 * forced into a single table.
 */
function createBackupHealthReadiness(
  config: AppConfig,
  pool: Parameters<typeof createPostgresBackupHealth>[0],
): BackupHealthReadinessPort {
  // `loadConfig` always populates this; the fallback only keeps hand-built
  // fixtures compiling, and mirrors the documented unset default exactly.
  const { provider, observationPath } = config.backupProvider
    ?? { provider: DEFAULT_BACKUP_PROVIDER, observationPath: null };
  if (provider === 'host-observation') {
    if (observationPath === null) {
      // Unreachable through loadConfig, but never degrade silently.
      throw new Error('BACKUP_OBSERVATION_PATH is required when BACKUP_PROVIDER=host-observation');
    }
    return createHostBackupObservationHealth({ observationPath });
  }
  if (provider === 'br5-r2') {
    return createPostgresBackupHealth(pool, {
      workerEnabled: config.backupWorker?.enabled === true,
    });
  }
  // Intentionally disabled: a distinct truthful state, not a failed backup run.
  return createDisabledBackupHealth();
}

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
    const reportReadSnapshot = new PostgresReportReadSnapshot(database.pool, jobCards);
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
      weeklyReportHistoryReadPort: jobCards,
      peopleRepository: new PostgresPeopleRepository(
        database.pool, credentials, sessions, customerAssignments,
      ),
      crmRepository: new PostgresCrmRepository(database.pool),
      productRepository: new PostgresProductRepository(database.pool),
      reportReadSnapshot,
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
          onError: (error) => {
            console.error('Calendar reminder worker tick failed', error);
          },
        },
      ),
      // OVR-3: the clock-only breach scanner is a system producer. It is
      // constructed only when explicitly enabled, so a default deployment
      // keeps its previous behaviour.
      ...(config.overdueScanner?.enabled === true
        ? {
            overdueBreachScanner: createOverdueBreachScanner(
              new PostgresOverdueBreachScannerRepository(jobCards),
              {
                pollIntervalMs: config.overdueScanner.pollIntervalMs,
                batchSize: config.overdueScanner.batchSize,
                onReport: (report) => {
                  // OVR-3 activation monitoring is complete, so the detailed
                  // per-iteration report is kept at debug level. The error path
                  // stays visible: iteration failures are reported via onError.
                  app?.log.debug(
                    { overdueScan: report },
                    'Overdue breach scan iteration',
                  );
                },
                onError: (error) => {
                  console.error('Overdue breach scanner iteration failed', error);
                },
              },
            ),
          }
        : {}),
      staffConfidentialNotesRepository: new PostgresStaffConfidentialNotesRepository(
        database.pool,
      ),
      healthReadiness: createPostgresReadiness(database.pool, catalog),
      backupHealthReadiness: createBackupHealthReadiness(config, database.pool),
      realtimeService,
      realtimePublisher: realtimeBus,
      notificationRepository: new PostgresNotificationRepository(database.pool),
      webPushRepository: new PostgresWebPushRepository(database.pool),
      pool: database.pool,
    });
    app = await buildApp(config, appDependencies);

    const shutdown = createShutdown({
      closeApp: async () => {
        // OVR-3 outage follow-up: record how many realtime streams are open so
        // shutdown is never silent about the teardown it is performing.
        const streams = realtimeService.openSubscriptionCount;
        if (streams > 0) {
          app!.log.info({ streams }, 'Closing realtime streams');
        }
        await app!.close();
      },
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
