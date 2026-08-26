import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { HealthReadinessPort } from '../src/modules/health/service.js';
import type { BackupHealthReadinessPort } from '../src/modules/health/service.js';
import { createPostgresReadiness } from '../src/modules/health/postgres-readiness.js';
import { createPostgresBackupHealth } from '../src/modules/health/postgres-backup-health.js';
import { loadMigrationCatalog } from '../src/db/migration-catalog.js';

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
    const catalog = await loadMigrationCatalog(
      fileURLToPath(new URL('../src/db/migrations', import.meta.url)),
    );
    const readiness = createPostgresReadiness(pool as never, catalog as never);
    const app = await buildApp(testConfig, { healthReadiness: readiness });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(response.json())).not.toContain('secret-db-host');
  });

  it('requires exact catalog history for readiness', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'health-cat-'));
    try {
      await writeFile(path.join(dir, '001_first.sql'), 'SELECT 1;');
      await writeFile(path.join(dir, '002_second.sql'), 'SELECT 2;');
      const catalog = await loadMigrationCatalog(dir);

      const okPool = {
        query: async (sql: string) => {
          if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
          if (sql.includes('schema_migrations')) return { rows: [{ version: '001_first' }, { version: '002_second' }] };
          return { rows: [] };
        },
      };
      const behindPool = {
        query: async (sql: string) => {
          if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
          if (sql.includes('schema_migrations')) return { rows: [{ version: '001_first' }] };
          return { rows: [] };
        },
      };
      const emptyPool = {
        query: async (sql: string) => {
          if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
          if (sql.includes('schema_migrations')) return { rows: [] };
          return { rows: [] };
        },
      };
      const aheadPool = {
        query: async (sql: string) => {
          if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
          if (sql.includes('schema_migrations')) return { rows: [{ version: '001_first' }, { version: '002_second' }, { version: '003_future' }] };
          return { rows: [] };
        },
      };

      const ok = createPostgresReadiness(okPool as never, catalog as never);
      const behind = createPostgresReadiness(behindPool as never, catalog as never);
      const empty = createPostgresReadiness(emptyPool as never, catalog as never);
      const ahead = createPostgresReadiness(aheadPool as never, catalog as never);

      await expect(ok.check()).resolves.toBe('ok');
      await expect(behind.check()).resolves.toBe('unavailable');
      await expect(empty.check()).resolves.toBe('unavailable');
      await expect(ahead.check()).resolves.toBe('unavailable');

      // Regression: stale expected version must not authorize DB with extra future row
      // (old string path would have returned ok for 001..002 + 003_future when checking 002_second)
      await expect(ahead.check()).resolves.toBe('unavailable');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces safe backup worker evidence without changing the generic status contract', async () => {
    const backupReadiness: BackupHealthReadinessPort = {
      check: async () => ({
        status: 'ok',
        latestVerifiedAt: '2026-08-23T01:00:00.000Z',
        latestScheduledVerifiedAt: '2026-08-23T01:00:00.000Z',
        latestRunStatus: 'SUCCESS',
        latestScheduledRunStatus: 'SUCCESS',
        workerHeartbeatAt: '2026-08-23T01:01:00.000Z',
        schedulerLastTickAt: '2026-08-23T01:00:00.000Z',
      }),
    };
    const app = await buildApp(testConfig, {
      healthReadiness: { check: async () => 'ok' },
      backupHealthReadiness: backupReadiness,
    });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', backup: { status: 'ok', latestRunStatus: 'SUCCESS' } });
    const backup = await app.inject({ method: 'GET', url: '/api/health/backup' });
    expect(backup.statusCode).toBe(200);
    expect(backup.json()).toMatchObject({ status: 'ok', workerHeartbeatAt: expect.any(String) });
  });

  it('uses scheduled verified evidence and both liveness timestamps for backup health', async () => {
    const now = new Date('2026-08-23T02:00:00.000Z');
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("origin = 'SCHEDULED'") && sql.includes('verified_at')) {
          return { rows: [{ verified_at: new Date('2026-08-23T01:00:00.000Z') }] };
        }
        if (sql.includes("origin = 'SCHEDULED'")) return { rows: [{ status: 'SUCCESS' }] };
        if (sql.includes('worker_heartbeat_at')) {
          return {
            rows: [{
              worker_heartbeat_at: new Date('2026-08-23T01:59:00.000Z'),
              scheduler_last_tick_at: new Date('2026-08-23T01:58:00.000Z'),
            }],
          };
        }
        return { rows: [{ verified_at: new Date('2026-08-23T01:00:00.000Z') }] };
      },
    };
    const health = createPostgresBackupHealth(pool as never, { workerEnabled: true, now: () => now });
    await expect(health.check()).resolves.toMatchObject({
      status: 'ok',
      latestVerifiedAt: '2026-08-23T01:00:00.000Z',
      latestScheduledVerifiedAt: '2026-08-23T01:00:00.000Z',
      latestScheduledRunStatus: 'SUCCESS',
    });
  });

  it.each([
    {
      label: 'missing verified_at even when latest runs report SUCCESS',
      verifiedAt: null,
      scheduledVerifiedAt: null,
      latestStatus: 'SUCCESS',
      scheduledLatestStatus: 'SUCCESS',
      workerHeartbeatAt: new Date('2026-08-23T01:59:00.000Z'),
      schedulerLastTickAt: new Date('2026-08-23T01:59:00.000Z'),
    },
    {
      label: 'stale worker heartbeat',
      verifiedAt: new Date('2026-08-23T01:00:00.000Z'),
      scheduledVerifiedAt: new Date('2026-08-23T01:00:00.000Z'),
      latestStatus: 'SUCCESS',
      scheduledLatestStatus: 'SUCCESS',
      workerHeartbeatAt: new Date('2026-08-22T23:00:00.000Z'),
      schedulerLastTickAt: new Date('2026-08-23T01:59:00.000Z'),
    },
    {
      label: 'stale scheduler heartbeat',
      verifiedAt: new Date('2026-08-23T01:00:00.000Z'),
      scheduledVerifiedAt: new Date('2026-08-23T01:00:00.000Z'),
      latestStatus: 'SUCCESS',
      scheduledLatestStatus: 'SUCCESS',
      workerHeartbeatAt: new Date('2026-08-23T01:59:00.000Z'),
      schedulerLastTickAt: new Date('2026-08-22T23:00:00.000Z'),
    },
  ])('fails closed for $label', async (fixture) => {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("origin = 'SCHEDULED'") && sql.includes('verified_at IS NOT NULL')) {
          return { rows: fixture.scheduledVerifiedAt ? [{ verified_at: fixture.scheduledVerifiedAt }] : [] };
        }
        if (sql.includes('status = \'SUCCESS\' AND verified_at IS NOT NULL')) {
          return { rows: fixture.verifiedAt ? [{ verified_at: fixture.verifiedAt }] : [] };
        }
        if (sql.includes('worker_heartbeat_at')) {
          return {
            rows: [{
              worker_heartbeat_at: fixture.workerHeartbeatAt,
              scheduler_last_tick_at: fixture.schedulerLastTickAt,
            }],
          };
        }
        if (sql.includes("origin = 'SCHEDULED'")) {
          return { rows: [{ status: fixture.scheduledLatestStatus }] };
        }
        return { rows: [{ status: fixture.latestStatus }] };
      },
    };
    const health = createPostgresBackupHealth(pool as never, {
      workerEnabled: true,
      now: () => new Date('2026-08-23T02:00:00.000Z'),
    });
    await expect(health.check()).resolves.toMatchObject({ status: 'unavailable' });
  });
});
