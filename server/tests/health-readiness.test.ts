import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { HealthReadinessPort } from '../src/modules/health/service.js';
import { createPostgresReadiness } from '../src/modules/health/postgres-readiness.js';

const testConfig: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  databaseUrl: 'postgresql://unused-in-app-test',
  logLevel: 'silent',
  corsOrigin: 'http://127.0.0.1:5173',
  sessionTtlSeconds: 28_800,
  loginRateLimitMax: 5,
  rateLimitWindowMs: 60_000,
  trustedProxy: 'loopback',
  healthSchemaVersion: null,
};

describe('GET /api/health readiness', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('returns 200 ok when readiness is ok', async () => {
    const readiness: HealthReadinessPort = { check: async () => 'ok' };
    const app = await buildApp(testConfig, { healthReadiness: readiness });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 unavailable when readiness fails', async () => {
    const readiness: HealthReadinessPort = { check: async () => 'unavailable' };
    const app = await buildApp(testConfig, { healthReadiness: readiness });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(response.json())).not.toMatch(/database|migration|error|host/i);
  });

  it('returns 503 when the database pool rejects queries', async () => {
    const pool = {
      query: async () => {
        throw new Error('ECONNREFUSED secret-db-host');
      },
    };
    const readiness = createPostgresReadiness(pool as never, '007_sales_meeting');
    const app = await buildApp(testConfig, { healthReadiness: readiness });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(response.json())).not.toContain('secret-db-host');
  });

  it('requires exact schema version when HEALTH_SCHEMA_VERSION is set', async () => {
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
        if (sql.includes('schema_migrations WHERE version')) {
          return {
            rows: values?.[0] === '007_sales_meeting'
              ? [{ version: '007_sales_meeting' }]
              : [],
          };
        }
        return { rows: [] };
      },
    };
    const ready = createPostgresReadiness(pool as never, '007_sales_meeting');
    const missing = createPostgresReadiness(pool as never, '008_missing');
    await expect(ready.check()).resolves.toBe('ok');
    await expect(missing.check()).resolves.toBe('unavailable');
  });
});
