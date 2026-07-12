import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, LOGGER_REDACT_PATHS } from '../src/app.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /api/health', () => {
  it('returns only the generic public health status', async () => {
    const app = await buildApp({
      nodeEnv: 'test',
      host: '127.0.0.1',
      port: 3000,
      databaseUrl: 'postgresql://unused-in-health-test',
      logLevel: 'silent',
      corsOrigin: 'http://127.0.0.1:5173',
      sessionTtlSeconds: 28_800,
      loginRateLimitMax: 5,
      rateLimitWindowMs: 60_000,
    });
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
