import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp, LOGGER_REDACT_PATHS } from '../src/app.js';
import type { AppDependencies } from '../src/app.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const testConfig = {
  nodeEnv: 'test' as const,
  host: '127.0.0.1',
  port: 3000,
  databaseUrl: 'postgresql://unused-in-app-test',
  logLevel: 'silent',
  corsOrigin: 'http://127.0.0.1:5173',
  sessionTtlSeconds: 28_800,
  loginRateLimitMax: 5,
  rateLimitWindowMs: 60_000,
  trustedProxy: 'loopback' as const,
  healthSchemaVersion: null,
  releaseSha: 'dev',
  actionScopedGeolocationEnabled: false,
  reverseGeocoderProvider: null,
  googleGeocodingApiKey: null,
  reverseGeocoderTimeoutMs: 2000,
  geocodingUserDailyLimit: 15,
  geocodingOrganizationDailyLimit: 250,
  geocodingGlobalMonthlyLimit: 8000,
  webPush: {
    enabled: false,
    vapidSubject: null,
    vapidPublicKey: null,
    vapidPrivateKey: null,
  },
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /api/health', () => {
  it('returns the generic public health status with the server release SHA', async () => {
    const app = await buildApp(testConfig);
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', releaseSha: 'dev' });
  });
});

describe('logger security defaults', () => {
  it('redacts authentication and password-bearing paths', () => {
    expect(LOGGER_REDACT_PATHS).toEqual(
      expect.arrayContaining([
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
        'backupR2.accessKeyId',
        'backupR2.secretAccessKey',
        'config.backupR2.accessKeyId',
        'config.backupR2.secretAccessKey',
      ]),
    );
  });
});

describe('AppDependencies', () => {
  it('mounts all dedicated Weekly Report routes with the domain authentication and password gate', async () => {
    let mustChangePassword = true;
    const getOrganizationTimezone = vi.fn().mockResolvedValue('Europe/Istanbul');
    const app = await buildApp(testConfig, {
      authRepository: {
        findSessionWithUser: async () => ({
          session: { id: 'session-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) },
          user: { id: 'staff-1', organizationId: 'org-1', role: 'STAFF', isActive: true, mustChangePassword },
        }),
      } as never,
      jobCardRepository: { getOrganizationTimezone } as never,
    });
    apps.push(app);

    const report = '/api/job-cards/job-1/weekly-report';
    const reference = '/api/job-cards/weekly-reports/reference';
    const routes = [
      ['POST', '/api/job-cards/weekly-reports'],
      ['POST', '/api/job-cards/weekly-reports/bulk-request'],
      ['GET', reference],
      ['GET', report],
      ['PATCH', report],
      ['GET', `${report}/removal-preview`],
      ['POST', `${report}/remove`],
      ['GET', `${report}/submissions`],
      ['GET', `${report}/submissions/1/pdf`],
    ] as const;
    const cookies = { servora_session: 'test-session' };
    for (const [method, url] of routes) {
      expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401);
      const passwordBlocked = await app.inject({ method, url, cookies });
      expect(passwordBlocked.statusCode, `${method} ${url}`).toBe(403);
      expect(passwordBlocked.json()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    expect(getOrganizationTimezone).not.toHaveBeenCalled();

    mustChangePassword = false;
    const response = await app.inject({ method: 'GET', url: reference, cookies });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ timezone: 'Europe/Istanbul' });
    expect(getOrganizationTimezone).toHaveBeenCalledExactlyOnceWith('org-1');
  });

  it('accepts the optional CRM repository dependency', () => {
    const dependencies = { crmRepository: {} as AppDependencies['crmRepository'] } satisfies AppDependencies;
    expect(dependencies.crmRepository).toBeDefined();
  });

  it('accepts the optional Product repository dependency', () => {
    const dependencies = {
      productRepository: {} as AppDependencies['productRepository'],
    } satisfies AppDependencies;
    expect(dependencies.productRepository).toBeDefined();
  });

  it('registers the Admin-only Data Management summary with its read model', async () => {
    const app = await buildApp(testConfig, {
      authRepository: {} as never,
      dataManagementRepository: {} as never,
    });
    apps.push(app);

    expect(app.hasRoute({ method: 'GET', url: '/api/admin/data-management/summary' })).toBe(true);
  });

  it('registers People only with the shared report read model', async () => {
    const withoutReports = await buildApp(testConfig, {
      authRepository: {} as never,
      peopleRepository: {} as never,
    });
    const withReports = await buildApp(testConfig, {
      authRepository: {} as never,
      peopleRepository: {} as never,
      reportsRepository: {} as never,
    });
    apps.push(withoutReports, withReports);

    expect(withoutReports.hasRoute({ method: 'GET', url: '/api/staff' })).toBe(false);
    expect(withReports.hasRoute({ method: 'GET', url: '/api/staff' })).toBe(true);
  });

  it('registers Staff offboarding only when the People route also has a PostgreSQL pool', async () => {
    const withoutPool = await buildApp(testConfig, {
      authRepository: {} as never,
      peopleRepository: {} as never,
      reportsRepository: {} as never,
    });
    const withPool = await buildApp(testConfig, {
      authRepository: {} as never,
      peopleRepository: {} as never,
      reportsRepository: {} as never,
      pool: {} as never,
    });
    apps.push(withoutPool, withPool);

    expect(withoutPool.hasRoute({ method: 'POST', url: '/api/users/:userId/offboarding/preview' })).toBe(false);
    expect(withPool.hasRoute({ method: 'POST', url: '/api/users/:userId/offboarding/preview' })).toBe(true);
    expect(withPool.hasRoute({ method: 'POST', url: '/api/users/:userId/offboarding/execute' })).toBe(true);
  });

  it('registers Reports only with both the read model and the read snapshot', async () => {
    const withoutSnapshot = await buildApp(testConfig, {
      authRepository: {} as never,
      reportsRepository: {} as never,
    });
    const complete = await buildApp(testConfig, {
      authRepository: {} as never,
      reportsRepository: {} as never,
      reportReadSnapshot: {} as never,
    });
    apps.push(withoutSnapshot, complete);

    expect(withoutSnapshot.hasRoute({ method: 'GET', url: '/api/reports/dashboard' })).toBe(false);
    expect(complete.hasRoute({ method: 'GET', url: '/api/reports/dashboard' })).toBe(true);
  });

  it('does not expose realtime routes without realtime dependencies', async () => {
    const app = await buildApp(testConfig);
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/realtime/events',
    });

    expect(response.statusCode).toBe(404);
  });

  it('registers the realtime route when auth and service exist', async () => {
    const app = await buildApp(testConfig, {
      authRepository: {} as never,
      realtimeService: {
        open: async () => ({ close() {} }),
        close() {},
      } as never,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/realtime/events',
    });

    expect(response.statusCode).toBe(401);
  });
});
