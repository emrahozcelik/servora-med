import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

describe('buildApp serialized logger redaction', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('redacts secrets using production LOGGER_REDACT_PATHS from buildApp', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });

    const config: AppConfig = {
      nodeEnv: 'test',
      host: '127.0.0.1',
      port: 3000,
      databaseUrl: 'postgresql://unused',
      logLevel: 'info',
      corsOrigin: 'https://app.example.com',
      sessionTtlSeconds: 28_800,
      loginRateLimitMax: 20,
      rateLimitWindowMs: 60_000,
      trustedProxy: 'loopback',
      healthSchemaVersion: null,
      actionScopedGeolocationEnabled: false,
      webPush: {
        enabled: false,
        vapidSubject: null,
        vapidPublicKey: null,
        vapidPrivateKey: null,
      },
    };

    const app = await buildApp(config, { loggerDestination: stream });
    apps.push(app);

    app.post('/probe-log', async (request) => {
      request.log.info({
        req: {
          headers: request.headers,
          body: request.body,
        },
      }, 'probe');
      return { ok: true };
    });

    await app.inject({
      method: 'POST',
      url: '/probe-log',
      headers: {
        authorization: 'Bearer secret-token-value',
        cookie: 'session=raw-session-cookie',
      },
      payload: {
        password: 'super-secret-password',
        currentPassword: 'old-secret',
        newPassword: 'new-secret',
        temporaryPassword: 'temp-secret',
        token: 'raw-token-value',
        sessionToken: 'raw-session-token',
        locationCapture: {
          outcome: 'captured',
          latitude: 39.92077,
          longitude: 32.85411,
          accuracyMeters: 24.5,
          capturedAt: '2026-07-21T06:15:30.123Z',
        },
      },
    });

    const joined = lines.join('\n');
    expect(joined).toMatch(/probe/);
    for (const secret of [
      'super-secret-password',
      'old-secret',
      'new-secret',
      'temp-secret',
      'raw-session-cookie',
      'secret-token-value',
      'raw-token-value',
      'raw-session-token',
      '39.92077',
      '32.85411',
      '24.5',
      '2026-07-21T06:15:30.123Z',
    ]) {
      expect(joined).not.toContain(secret);
    }
  });
});
