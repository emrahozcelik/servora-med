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
import type { BackupVerificationProof } from '../src/modules/backup/trusted-evidence.js';
import { loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { timeAt } from './backup-time-fixture.js';

const TEST_RELEASE_SHA = '6325e44bf774d2cb0de2c4cd27ba93443b57d4c0';

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
  releaseSha: TEST_RELEASE_SHA,
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
    expect(response.json()).toEqual({ status: 'ok', releaseSha: TEST_RELEASE_SHA });
  });

  it('exposes the dev release identity outside controlled releases', async () => {
    const readiness: HealthReadinessPort = { check: async () => 'ok' };
    const app = await buildApp({ ...testConfig, releaseSha: 'dev' }, { healthReadiness: readiness });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', releaseSha: 'dev' });
  });

  it('returns 503 unavailable when readiness fails', async () => {
    const readiness: HealthReadinessPort = { check: async () => 'unavailable' };
    const app = await buildApp(testConfig, { healthReadiness: readiness });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', releaseSha: TEST_RELEASE_SHA });
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
    expect(response.json()).toEqual({ status: 'unavailable', releaseSha: TEST_RELEASE_SHA });
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

  it('maps rich backup states to exact HTTP status and preserves providerStatus', async () => {
    const states = [
      { status: 'ok', providerStatus: 'healthy', code: 200 },
      { status: 'unavailable', providerStatus: 'stale', code: 503 },
      { status: 'unavailable', providerStatus: 'failed', code: 503 },
      { status: 'unavailable', providerStatus: 'unavailable', code: 503 },
    ] as const;
    for (const state of states) {
      const backupReadiness: BackupHealthReadinessPort = {
        check: async () => ({
          status: state.status,
          provider: 'br5-r2',
          providerStatus: state.providerStatus,
          latestVerifiedAt: null,
          latestScheduledVerifiedAt: null,
          latestRunStatus: null,
          latestScheduledRunStatus: null,
          workerHeartbeatAt: null,
          schedulerLastTickAt: null,
        }),
      };
      const app = await buildApp(testConfig, {
        healthReadiness: { check: async () => 'ok' },
        backupHealthReadiness: backupReadiness,
      });
      apps.push(app);
      const response = await app.inject({ method: 'GET', url: '/api/health/backup' });
      expect(response.statusCode).toBe(state.code);
      expect(response.json()).toMatchObject({
        status: state.status,
        providerStatus: state.providerStatus,
      });
    }
  });

  it('does not expose evidence details through the public health projection', async () => {
    const backupReadiness: BackupHealthReadinessPort = {
      check: async () => ({
        status: 'ok',
        provider: 'br5-r2',
        providerStatus: 'healthy',
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
    const serialized = JSON.stringify(response.json());
    for (const forbidden of [
      'bootId', 'timeNamespaceId', 'sourcePolicy', 'configSha256',
      'artifactGenerationId', 'remoteAttemptId', 'remoteKey', 'sha256',
      'verificationTimeEvidence',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
  it('uses scheduled verified evidence and both liveness timestamps for backup health', async () => {
    const start = Date.parse('2026-08-23T01:00:00.000Z');
    const current = timeAt(start + 60 * 60 * 1000);
    const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const generationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const remoteKey = `production/instance/v1/scheduled/${runId}.sbk.age`;
    const sha256 = 'a'.repeat(64);
    const proof: BackupVerificationProof = {
      proofVersion: 2,
      runId,
      artifactGenerationId: generationId,
      artifactSha256: sha256,
      sizeBytes: 1024,
      remoteAttemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      origin: 'SCHEDULED',
      remoteKey,
      generationStartedAt: timeAt(start).wallAtUTC,
      verificationAttemptStartedAt: new Date(start + 30_000).toISOString(),
      verifiedAt: timeAt(start + 60_000).wallAtUTC,
      before: timeAt(start),
      after: timeAt(start + 60_000),
    };
    const row = {
      id: runId,
      status: 'SUCCESS',
      origin: 'SCHEDULED',
      verified_at: new Date(proof.verifiedAt),
      remote_key: remoteKey,
      size_bytes: 1024,
      sha256,
      artifact_generation_id: generationId,
      artifact_generation_time_evidence: proof.before,
      verification_time_evidence: proof,
    };
    const heartbeatEvidence = timeAt(start + 59 * 60 * 1000);
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('active_running')) return { rows: [{ active: false }] };
        if (sql.includes('scheduled_verified') || sql.includes('latest_verified')) {
          return { rows: [row] };
        }
        if (sql.includes('scheduled_run_status') || sql.includes('latest_run_status')) {
          return { rows: [{ status: 'SUCCESS' }] };
        }
        if (sql.includes('backup_worker_state')) {
          return {
            rows: [{
              worker_heartbeat_at: new Date(heartbeatEvidence.wallAtUTC),
              scheduler_last_tick_at: new Date(heartbeatEvidence.wallAtUTC),
              worker_heartbeat_time_evidence: heartbeatEvidence,
              scheduler_last_tick_time_evidence: heartbeatEvidence,
            }],
          };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
    const health = createPostgresBackupHealth(pool as never, {
      workerEnabled: true,
      sampleTime: async () => current,
    });
    await expect(health.check()).resolves.toMatchObject({
      status: 'ok',
      providerStatus: 'healthy',
      latestVerifiedAt: proof.verifiedAt,
      latestScheduledVerifiedAt: proof.verifiedAt,
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
