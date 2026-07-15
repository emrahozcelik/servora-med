import { afterEach, describe, expect, it } from 'vitest';

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
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /api/health', () => {
  it('returns only the generic public health status', async () => {
    const app = await buildApp(testConfig);
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
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
      ]),
    );
  });
});

describe('AppDependencies', () => {
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

  it('registers Reports only with both read-model and approval-item ports', async () => {
    const withoutApprovalItems = await buildApp(testConfig, {
      authRepository: {} as never,
      reportsRepository: {} as never,
    });
    const complete = await buildApp(testConfig, {
      authRepository: {} as never,
      reportsRepository: {} as never,
      approvalQueueItemPort: {} as never,
    });
    apps.push(withoutApprovalItems, complete);

    expect(withoutApprovalItems.hasRoute({ method: 'GET', url: '/api/reports/dashboard' })).toBe(false);
    expect(complete.hasRoute({ method: 'GET', url: '/api/reports/dashboard' })).toBe(true);
  });
});
