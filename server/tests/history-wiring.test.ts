import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

const config = {
  nodeEnv: 'test' as const, host: '127.0.0.1', port: 3000,
  databaseUrl: 'postgresql://unused', logLevel: 'silent', corsOrigin: 'http://127.0.0.1:5173',
  sessionTtlSeconds: 28_800, loginRateLimitMax: 5, rateLimitWindowMs: 60_000,
  trustedProxy: 'loopback' as const, healthSchemaVersion: null, releaseSha: 'dev', actionScopedGeolocationEnabled: false,
  reverseGeocoderProvider: null, googleGeocodingApiKey: null, reverseGeocoderTimeoutMs: 2_000,
  geocodingUserDailyLimit: 15, geocodingOrganizationDailyLimit: 250, geocodingGlobalMonthlyLimit: 8_000,
  webPush: { enabled: false, vapidSubject: null, vapidPublicKey: null, vapidPrivateKey: null },
};
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('F3 history port application wiring', () => {
  it('keeps CRM/People routes available without history and adds only history routes when wired', async () => {
    const shared = {
      authRepository: {} as never,
      peopleRepository: {} as never,
      reportsRepository: {} as never,
      crmRepository: {} as never,
    };
    const withoutPort = await buildApp(config, shared);
    const withPort = await buildApp(config, { ...shared, jobHistoryReadPort: {} as never });
    apps.push(withoutPort, withPort);

    expect(withoutPort.hasRoute({ method: 'GET', url: '/api/customers' })).toBe(true);
    expect(withoutPort.hasRoute({ method: 'GET', url: '/api/staff' })).toBe(true);
    expect(withoutPort.hasRoute({ method: 'GET', url: '/api/customers/:customerId/jobs' })).toBe(false);
    expect(withoutPort.hasRoute({ method: 'GET', url: '/api/staff/me/jobs' })).toBe(false);
    expect(withPort.hasRoute({ method: 'GET', url: '/api/customers/:customerId/jobs' })).toBe(true);
    expect(withPort.hasRoute({ method: 'GET', url: '/api/staff/me/jobs' })).toBe(true);
    expect(withPort.hasRoute({ method: 'GET', url: '/api/staff/:userId/jobs' })).toBe(true);
  });
});
