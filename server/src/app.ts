import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';

import type { AppConfig } from './config.js';
import { resolveTrustProxyOption } from './config.js';
import { toErrorResponse } from './errors/index.js';
import { healthRoutes } from './modules/health/routes.js';
import {
  alwaysOkReadiness,
  type BackupHealthReadinessPort,
  type HealthReadinessPort,
} from './modules/health/service.js';
import { AuthService } from './modules/auth/service.js';
import type { AuthRepository } from './modules/auth/repository.js';
import { authRoutes } from './modules/auth/routes.js';
import { AppError } from './errors/index.js';
import type { JobCardRepository } from './modules/job-cards/repository.js';
import type { JobHistoryReadPort } from './modules/job-cards/history-port.js';
import { JobCardService } from './modules/job-cards/service.js';
import { jobCardRoutes } from './modules/job-cards/routes.js';
import { requireAuthentication, requirePasswordChanged } from './modules/auth/middleware.js';
import { referenceRoutes } from './modules/job-cards/reference-routes.js';
import type { PeopleRepository } from './modules/people/repository.js';
import { PostgresStaffOffboardingService } from './modules/people/offboarding.js';
import { PeopleService } from './modules/people/service.js';
import { peopleRoutes } from './modules/people/routes.js';
import { AuthCredentialAdministration } from './modules/auth/admin-ports.js';
import type { CrmRepository } from './modules/crm/repository.js';
import { CrmService } from './modules/crm/service.js';
import { crmRoutes } from './modules/crm/routes.js';
import type { ProductRepository } from './modules/products/repository.js';
import { ProductService } from './modules/products/service.js';
import { productRoutes } from './modules/products/routes.js';
import type { ApprovalQueueItemPort, ReportsReadModel } from './modules/reports/ports.js';
import { ReportsService } from './modules/reports/service.js';
import { reportsRoutes } from './modules/reports/routes.js';
import type {
  RealtimeEventPublisher,
} from './modules/realtime/event-bus.js';
import type {
  RealtimeService,
} from './modules/realtime/service.js';
import {
  realtimeRoutes,
} from './modules/realtime/routes.js';
import type { NotificationRepository } from './modules/notifications/repository.js';
import { NotificationService } from './modules/notifications/service.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import type { ReverseGeocoder } from './modules/job-cards/reverse-geocoder.js';
import type { ReverseGeocodingQuotaGuard } from './modules/geocoding/reverse-geocoding-quota.js';
import type { WebPushRepository } from './modules/web-push/repository.js';
import { WebPushService } from './modules/web-push/service.js';
import { webPushRoutes } from './modules/web-push/routes.js';
import type { WebPushDispatcher } from './modules/web-push/dispatcher.js';
import { createDispatcher } from './modules/web-push/dispatcher.js';
import { createWebPushSender } from './modules/web-push/sender.js';
import { buildPushPayload, buildPushTopic } from './modules/web-push/payload.js';
import type { OverviewReadModel } from './modules/overview/repository.js';
import { OverviewService } from './modules/overview/service.js';
import { overviewRoutes } from './modules/overview/routes.js';
import type { CalendarRepository } from './modules/calendar/repository.js';
import { CalendarService } from './modules/calendar/service.js';
import { calendarRoutes } from './modules/calendar/routes.js';
import type { CalendarReminderWorker } from './modules/calendar/reminder-worker.js';
import { MessagingService } from './modules/messaging/service.js';
import { PostgresMessagingRepository } from './modules/messaging/repository.js';
import { messagingRoutes } from './modules/messaging/routes.js';
import type { StaffConfidentialNotesRepository } from './modules/staff-confidential-notes/repository.js';
import { StaffConfidentialNotesService } from './modules/staff-confidential-notes/service.js';
import { staffConfidentialNotesRoutes } from './modules/staff-confidential-notes/routes.js';
import { randomUUID } from 'node:crypto';

import { buildConnectionTestKey } from './modules/backup/object-keys.js';
import {
  CloudflareR2Storage,
  R2_CONNECTION_TEST_TIMEOUT_MS,
  type R2ErrorClass,
} from './modules/backup/r2.js';
import type { BackupRepository } from './modules/backup/repository.js';
import { PostgresBackupRepository } from './modules/backup/repository.js';
import { BackupService } from './modules/backup/service.js';
import { backupRoutes } from './modules/backup/routes.js';
import type { DemoDatasetRepository } from './modules/demo-data/types.js';
import { DemoDatasetService } from './modules/demo-data/service.js';
import { PostgresDemoDatasetRepository } from './modules/demo-data/repository.js';
import { demoDatasetRoutes } from './modules/demo-data/routes.js';

export const LOGGER_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.temporaryPassword',
  'req.body.token',
  'req.body.sessionToken',
  'req.body.locationCapture',
  'req.body.followUpInstructions',
  'req.body.endpoint',
  'req.body.keys',
  'req.body.payload',
  'req.body.vapidSubject',
  'req.body.vapidPublicKey',
  'req.body.vapidPrivateKey',
  'webPush.endpoint',
  'webPush.keys',
  'webPush.payload',
  'webPush.vapidSubject',
  'webPush.vapidPublicKey',
  'webPush.vapidPrivateKey',
  'req.body.body',
  'backupR2.accessKeyId',
  'backupR2.secretAccessKey',
  'config.backupR2.accessKeyId',
  'config.backupR2.secretAccessKey',
];

export type AppDependencies = {
  authRepository?: AuthRepository;
  jobCardRepository?: JobCardRepository;
  jobHistoryReadPort?: JobHistoryReadPort;
  peopleRepository?: PeopleRepository;
  crmRepository?: CrmRepository;
  productRepository?: ProductRepository;
  approvalQueueItemPort?: ApprovalQueueItemPort;
  reportsRepository?: ReportsReadModel;
  healthReadiness?: HealthReadinessPort;
  backupHealthReadiness?: BackupHealthReadinessPort;
  realtimeService?: RealtimeService;
  realtimePublisher?: RealtimeEventPublisher;
  notificationRepository?: NotificationRepository;
  reverseGeocoder?: ReverseGeocoder;
  reverseGeocodingQuotaGuard?: ReverseGeocodingQuotaGuard;
  webPushRepository?: WebPushRepository;
  webPushDispatcher?: WebPushDispatcher;
  overviewRepository?: OverviewReadModel;
  calendarRepository?: CalendarRepository;
  calendarReminderWorker?: CalendarReminderWorker;
  staffConfidentialNotesRepository?: StaffConfidentialNotesRepository;
  backupRepository?: BackupRepository;
  demoDatasetRepository?: DemoDatasetRepository;
  /** Optional Pino destination for tests that capture serialized log lines. */
  loggerDestination?: NodeJS.WritableStream;
  pool?: import('pg').Pool;
};

export function buildLoggerOptions(
  config: AppConfig,
  destination?: NodeJS.WritableStream,
) {
  return {
    level: config.logLevel,
    redact: LOGGER_REDACT_PATHS,
    ...(destination ? { stream: destination } : {}),
  };
}

export async function buildApp(config: AppConfig, dependencies: AppDependencies = {}) {
  if (config.actionScopedGeolocationEnabled && !dependencies.reverseGeocoder) {
    throw new Error(
      'ACTION_SCOPED_GEOLOCATION_ENABLED requires a configured reverse geocoder',
    );
  }

  const app = Fastify({
    trustProxy: resolveTrustProxyOption(config.trustedProxy),
    logger: buildLoggerOptions(config, dependencies.loggerDestination),
  });

  await app.register(cookie);
  await app.register(cors, { origin: config.corsOrigin, credentials: true });
  await app.register(rateLimit, { global: false });

  app.addHook('onRequest', async (request) => {
    if (
      config.nodeEnv === 'production' &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers.origin !== config.corsOrigin
    ) {
      throw new AppError('INVALID_ORIGIN', 403, 'İstek kaynağına izin verilmiyor.');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const response = toErrorResponse(error);
    if (response.statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled request error');
    }
    return reply.code(response.statusCode).send(response.body);
  });

  await app.register(healthRoutes, {
    prefix: '/api/health',
    readiness: dependencies.healthReadiness ?? alwaysOkReadiness,
    backupReadiness: dependencies.backupHealthReadiness,
  });
  if (dependencies.authRepository) {
    const authService = new AuthService(dependencies.authRepository, config.sessionTtlSeconds);
    await app.register(authRoutes, {
      prefix: '/api/auth',
      authService,
      config,
    });
    const authenticate = requireAuthentication(authService);
    const passwordChanged = requirePasswordChanged();
    const authenticateDomain = async (...args: Parameters<typeof authenticate>) => {
      await authenticate(...args);
      await passwordChanged(...args);
    };
    if (dependencies.jobCardRepository) {
      const jobCardService = new JobCardService(
        dependencies.jobCardRepository,
        undefined,
        dependencies.realtimePublisher,
        {
          enabled: config.actionScopedGeolocationEnabled,
          reverseGeocoder: dependencies.reverseGeocoder,
          quotaGuard: dependencies.reverseGeocodingQuotaGuard,
        },
        { enabled: config.webPush.enabled },
        {
          enabled: config.capabilities?.calendar ?? false,
          reminderLeadMinutes: config.calendarReminderLeadMinutes ?? 30,
        },
      );
      await app.register(jobCardRoutes, {
        prefix: '/api/job-cards',
        service: jobCardService,
        authenticate: authenticateDomain,
      });
      await app.register(referenceRoutes, {
        prefix: '/api/reference',
        service: jobCardService,
        authenticate: authenticateDomain,
      });
    }
    if (dependencies.peopleRepository && dependencies.reportsRepository) {
      await app.register(peopleRoutes, {
        prefix: '/api',
        service: new PeopleService(
          dependencies.peopleRepository,
          new AuthCredentialAdministration(),
          dependencies.reportsRepository,
          dependencies.jobHistoryReadPort,
        ),
        authenticate: authenticateDomain,
        jobHistoryReadPort: dependencies.jobHistoryReadPort,
        offboardingService: dependencies.pool
          ? new PostgresStaffOffboardingService(dependencies.pool, dependencies.realtimeService)
          : undefined,
      });
    }
    if (dependencies.reportsRepository && dependencies.approvalQueueItemPort) {
      await app.register(reportsRoutes, {
        prefix: '/api/reports',
        service: new ReportsService(
          dependencies.reportsRepository,
          dependencies.approvalQueueItemPort,
        ),
        authenticate: authenticateDomain,
      });
    }
    if (dependencies.overviewRepository) {
      const messagingReadPort = (dependencies.pool && config.capabilities?.messaging)
        ? new PostgresMessagingRepository(dependencies.pool)
        : undefined;

      await app.register(overviewRoutes, {
        prefix: '/api/overview',
        service: new OverviewService(
          config.capabilities?.overviewDashboard ?? false,
          dependencies.overviewRepository,
          dependencies.reportsRepository,
          undefined,
          config.capabilities?.calendar ?? false,
          config.capabilities?.messaging ?? false,
          messagingReadPort,
        ),
        authenticate: authenticateDomain,
      });
    }
    if (dependencies.calendarRepository) {
      await app.register(calendarRoutes, {
        prefix: '/api/calendar',
        service: new CalendarService(
          config.capabilities?.calendar ?? false,
          dependencies.calendarRepository,
        ),
        authenticate: authenticateDomain,
      });
      if (
        config.capabilities?.calendar
        && dependencies.calendarReminderWorker
      ) {
        app.addHook('onReady', () => {
          dependencies.calendarReminderWorker!.start();
        });
        app.addHook('onClose', async () => {
          await dependencies.calendarReminderWorker!.stop();
        });
      }
    }
    if (dependencies.crmRepository) {
      await app.register(crmRoutes, {
        prefix: '/api',
        service: new CrmService(dependencies.crmRepository, dependencies.jobHistoryReadPort),
        authenticate: authenticateDomain,
        jobHistoryReadPort: dependencies.jobHistoryReadPort,
      });
    }
    if (dependencies.productRepository) {
      await app.register(productRoutes, {
        prefix: '/api',
        service: new ProductService(dependencies.productRepository),
        authenticate: authenticateDomain,
      });
    }
    if (dependencies.realtimeService) {
      await app.register(realtimeRoutes, {
        prefix: '/api/realtime',
        service: dependencies.realtimeService,
        authenticate: authenticateDomain,
      });
      app.addHook('onClose', async () => {
        dependencies.realtimeService!.close();
      });
    }
    if (dependencies.notificationRepository) {
      await app.register(notificationRoutes, {
        prefix: '/api/notifications',
        service: new NotificationService(dependencies.notificationRepository),
        authenticate: authenticateDomain,
      });
    }
    if (dependencies.webPushRepository) {
      await app.register(webPushRoutes, {
        prefix: '/api/web-push',
        service: new WebPushService(config.webPush, dependencies.webPushRepository),
        authenticate: authenticateDomain,
      });

      if (config.webPush.enabled) {
        const wd =
          dependencies.webPushDispatcher ??
          createDispatcher(
            {},
            {
              repository: dependencies.webPushRepository,
              sender: createWebPushSender({
                subject: config.webPush.vapidSubject!,
                publicKey: config.webPush.vapidPublicKey!,
                privateKey: config.webPush.vapidPrivateKey!,
              }),
              buildPayload: buildPushPayload,
              topicBuilder: buildPushTopic,
            },
          );

        app.addHook('onReady', () => {
          wd.start();
        });
        app.addHook('onClose', async () => {
          await wd.stop();
        });
      }
    }
    if (dependencies.pool && config.capabilities?.messaging) {
      await app.register(messagingRoutes, {
        prefix: '/api/messaging',
        service: new MessagingService(
          dependencies.pool,
          config.capabilities?.messaging ?? false,
          dependencies.realtimePublisher,
        ),
        authenticate: authenticateDomain,
      });
    }
    if (dependencies.staffConfidentialNotesRepository) {
      await app.register(staffConfidentialNotesRoutes, {
        prefix: '/api',
        service: new StaffConfidentialNotesService(
          dependencies.staffConfidentialNotesRepository,
          dependencies.realtimePublisher,
        ),
        authenticate: authenticateDomain,
      });
    }
    if (dependencies.demoDatasetRepository || dependencies.pool) {
      await app.register(demoDatasetRoutes, {
        prefix: '/api/admin',
        service: new DemoDatasetService(
          dependencies.demoDatasetRepository
            ?? new PostgresDemoDatasetRepository(dependencies.pool!),
        ),
        authenticate: authenticateDomain,
      });
    }
    // Backup admin API: gated on the domain capability flag. BR1 is metadata
    // foundation only; BR2–BR4 execution secrets are NOT required to start.
    if (dependencies.pool && config.capabilities?.backup) {
      const backupRepository = dependencies.backupRepository
        ?? new PostgresBackupRepository(dependencies.pool);
      const r2 = config.backupR2;
      const r2Configured = Boolean(
        r2.accountId && r2.accessKeyId && r2.secretAccessKey && r2.bucket && r2.instanceId,
      );
      const storageProbe = r2Configured
        ? async () => {
            const storage = new CloudflareR2Storage({
              config: {
                accountId: r2.accountId!,
                accessKeyId: r2.accessKeyId!,
                secretAccessKey: r2.secretAccessKey!,
                bucket: r2.bucket!,
              },
              signal: AbortSignal.timeout(R2_CONNECTION_TEST_TIMEOUT_MS),
            });
            try {
              const result = await storage.testConnection(
                buildConnectionTestKey(r2.instanceId!, randomUUID()),
              );
              if (result.ok) return { ok: true } as const;
              switch (result.errorClass as R2ErrorClass) {
                case 'AUTH': return { ok: false, errorClass: 'AUTH' } as const;
                case 'NOT_FOUND':
                case 'PRECONDITION_FAILED': return { ok: false, errorClass: 'CONFIG' } as const;
                case 'OBJECT_TOO_LARGE': return { ok: false, errorClass: 'CONFIG' } as const;
                case 'TRANSPORT': return { ok: false, errorClass: 'TRANSPORT' } as const;
                case 'SERVICE': return { ok: false, errorClass: 'SERVICE' } as const;
                default: return { ok: false, errorClass: 'UNKNOWN' } as const;
              }
            } finally {
              storage.destroy();
            }
          }
        : async () => ({ ok: false, errorClass: 'CONFIG' as const });
      await app.register(backupRoutes, {
        prefix: '/api/admin',
        service: new BackupService(backupRepository, undefined, {
          enabled: r2Configured,
          bucketAlias: r2.bucketAlias,
          prefix: 'production/',
        }),
        authenticate: authenticateDomain,
        storageProbe,
      });
    }
  }

  return app;
}
