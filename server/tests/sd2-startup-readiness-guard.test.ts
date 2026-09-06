import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import {
  assertStartupSchemaCompatible,
  fetchAppliedVersions,
  getHealthSchemaVersionMismatchError,
  getMigrationsDirectory,
} from '../src/db/schema-compatibility.js';
import { createPostgresReadiness } from '../src/modules/health/postgres-readiness.js';

const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const distMigrationsDirectory = fileURLToPath(new URL('../dist/db/migrations', import.meta.url));

const testConfig: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  databaseUrl: 'postgresql://unused',
  logLevel: 'silent',
  corsOrigin: 'http://127.0.0.1:5173',
  sessionTtlSeconds: 28_800,
  loginRateLimitMax: 5,
  rateLimitWindowMs: 60_000,
  trustedProxy: 'loopback',
  healthSchemaVersion: null,
  releaseSha: 'dev',
  actionScopedGeolocationEnabled: false,
  reverseGeocoderProvider: null,
  googleGeocodingApiKey: null,
  reverseGeocoderTimeoutMs: 2000,
  geocodingUserDailyLimit: 15,
  geocodingOrganizationDailyLimit: 250,
  geocodingGlobalMonthlyLimit: 8000,
  webPush: { enabled: false, vapidSubject: null, vapidPublicKey: null, vapidPrivateKey: null },
};

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function mockPool(applied: string[] | Error) {
  return {
    query: async (sql: string) => {
      if (sql.includes('SELECT 1')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('schema_migrations')) {
        if (applied instanceof Error) throw applied;
        return { rows: applied.map((v) => ({ version: v })) };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
}

function createMockLogger() {
  const logs: Array<{ fields: Record<string, unknown>; msg: string }> = [];
  return {
    logs,
    logger: {
      error: (fields: Record<string, unknown>, msg: string) => logs.push({ fields, msg }),
    },
  };
}

describe('SD2 catalog source', () => {
  it('derives expected head from catalog as 043', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    expect(catalog.head?.version).toBe('043_job_card_schedule_and_assignment_history');
    expect(catalog.count).toBe(43);
    expect(catalog.entries[0]?.version).toBe('001_auth_foundation');
  });

  it('getMigrationsDirectory resolves to src in dev', async () => {
    const dir = getMigrationsDirectory();
    // In worktree src context, it should be src/db/migrations
    expect(dir).toMatch(/\/db\/migrations$/);
    const catalog = await loadMigrationCatalog(dir);
    expect(catalog.count).toBe(43);
  });

  it('dist migrations are copied and resolvable', async () => {
    // Build must have run; dist should exist after npm run build
    const { existsSync } = await import('node:fs');
    if (!existsSync(distMigrationsDirectory)) return;
    const catalog = await loadMigrationCatalog(distMigrationsDirectory);
    expect(catalog.head?.version).toBe('043_job_card_schedule_and_assignment_history');
    expect(catalog.count).toBe(43);
  });
});

describe('SD2 HEALTH_SCHEMA_VERSION assertion', () => {
  it('null in dev does not mismatch', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    expect(getHealthSchemaVersionMismatchError(catalog, null)).toBeNull();
  });
  it('043 matches head', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    expect(getHealthSchemaVersionMismatchError(
      catalog,
      '043_job_card_schedule_and_assignment_history',
    )).toBeNull();
  });
  it('036 mismatches', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const err = getHealthSchemaVersionMismatchError(catalog, '036_job_card_invalidated');
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/HEALTH_SCHEMA_VERSION mismatch/);
  });
});

describe('SD2 startup fail-fast', () => {
  it('COMPATIBLE allowed', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const pool = mockPool(catalog.entries.map((e) => e.version));
    const { logger } = createMockLogger();
    await expect(assertStartupSchemaCompatible({ pool, catalog, logger })).resolves.toBeUndefined();
  });
  it('BEHIND through 036 refused', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const applied = catalog.entries.filter((e) => e.number <= 36).map((e) => e.version);
    const pool = mockPool(applied);
    const { logger, logs } = createMockLogger();
    await expect(assertStartupSchemaCompatible({ pool, catalog, logger })).rejects.toThrow(/incompatibility: BEHIND/);
    expect(logs[0]?.msg).toMatch(/Run npm run migrate/);
      expect(logs[0]?.fields.pendingVersions).toEqual(['037_staff_offboarding_audit', '038_demo_dataset_audit_types', '039_contact_deleted_audit', '040_demo_lifecycle_simplification', '041_user_lifecycle_reconciliation', '042_unsuccessful_visit_reason', '043_job_card_schedule_and_assignment_history']);
  });
  it('BEHIND many (029 incident) refused with 9 pending', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const applied = catalog.entries.filter((e) => e.number <= 29).map((e) => e.version);
    const pool = mockPool(applied);
    const { logger, logs } = createMockLogger();
    await expect(assertStartupSchemaCompatible({ pool, catalog, logger })).rejects.toThrow(/BEHIND/);
    const pending = logs[0]?.fields.pendingVersions as string[];
    expect(pending).toEqual([
      '030_backup_domain_foundation',
      '031_backup_engine_failure_taxonomy_and_dump_version',
      '032_backup_r2_failure_taxonomy',
      '033_backup_worker_runtime',
      '034_demo_data_foundation',
      '035_demo_data_purge_foundation',
      '036_job_card_invalidated',
      '037_staff_offboarding_audit',
      '038_demo_dataset_audit_types',
      '039_contact_deleted_audit',
      '040_demo_lifecycle_simplification',
      '041_user_lifecycle_reconciliation',
      '042_unsuccessful_visit_reason',
      '043_job_card_schedule_and_assignment_history',
    ]);
    expect(logs[0]?.msg).toMatch(/Run npm run migrate/);
    expect(JSON.stringify(logs)).not.toMatch(/postgres/i);
  });
  it('EMPTY refused', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const pool = mockPool([]);
    const { logger } = createMockLogger();
    await expect(assertStartupSchemaCompatible({ pool, catalog, logger })).rejects.toThrow(/EMPTY/);
  });
  it('AHEAD with 044_future refused', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const pool = mockPool([...catalog.entries.map((e) => e.version), '044_future']);
    const { logger, logs } = createMockLogger();
    await expect(assertStartupSchemaCompatible({ pool, catalog, logger })).rejects.toThrow(/AHEAD/);
    expect(logs[0]?.msg).toMatch(/newer than this application release/);
  });
  it('DIVERGED with 037_other_branch refused', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const pool = mockPool([...catalog.entries.map((e) => e.version), '037_other_branch']);
    const { logger } = createMockLogger();
    await expect(assertStartupSchemaCompatible({ pool, catalog, logger })).rejects.toThrow(/DIVERGED/);
  });
  it('DIVERGED with garbage refused', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const pool = mockPool([...catalog.entries.map((e) => e.version), 'garbage']);
    await expect(assertStartupSchemaCompatible({ pool, catalog, logger: createMockLogger().logger })).rejects.toThrow(
      /DIVERGED/,
    );
  });
  it('missing schema_migrations refused with unavailable message', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const err = Object.assign(new Error('relation "schema_migrations" does not exist'), { code: '42P01' });
    const pool = mockPool(err);
    const { logger, logs } = createMockLogger();
    await expect(assertStartupSchemaCompatible({ pool, catalog, logger })).rejects.toThrow(/unavailable/);
    expect(logs[0]?.msg).toMatch(/Run npm run migrate for a new\/uninitialized database/);
  });
  it('empty catalog refused as release failure', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'empty-cat-'));
    tempDirs.push(dir);
    const catalog = await loadMigrationCatalog(dir);
    expect(catalog.count).toBe(0);
    const pool = mockPool([]);
    await expect(assertStartupSchemaCompatible({ pool, catalog })).rejects.toThrow(/empty or unavailable/);
  });
  it('does not log DATABASE_URL', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const pool = mockPool(catalog.entries.filter((e) => e.number <= 29).map((e) => e.version));
    const { logs, logger } = createMockLogger();
    await expect(assertStartupSchemaCompatible({ pool, catalog, logger })).rejects.toThrow();
    expect(JSON.stringify(logs)).not.toMatch(/postgres:\/\/|DATABASE_URL/);
  });
});

describe('SD2 app.listen proof', () => {
  it('incompatible schema detected before listen', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const pool = mockPool(catalog.entries.filter((e) => e.number <= 29).map((e) => e.version));
    let listenCalled = false;
    const mockApp = {
      log: { error: () => {}, info: () => {} },
      listen: async () => {
        listenCalled = true;
      },
      close: async () => {},
    };
    // Simulate index.ts guard
    const guard = async () => {
      await assertStartupSchemaCompatible({ pool, catalog, logger: mockApp.log as never });
      await mockApp.listen();
    };
    await expect(guard()).rejects.toThrow();
    expect(listenCalled).toBe(false);
  });
  it('compatible schema reaches listen', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const pool = mockPool(catalog.entries.map((e) => e.version));
    let listenCalled = false;
    const mockApp = {
      log: { error: () => {}, info: () => {} },
      listen: async () => {
        listenCalled = true;
      },
      close: async () => {},
    };
    await assertStartupSchemaCompatible({ pool, catalog, logger: mockApp.log as never });
    await mockApp.listen();
    expect(listenCalled).toBe(true);
  });
});

describe('SD2 readiness matrix', () => {
  async function healthStatusFor(applied: string[] | Error) {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const pool = mockPool(applied);
    const readiness = createPostgresReadiness(pool as never, catalog as never);
    // Use buildApp to get HTTP semantics
    const app = await buildApp(testConfig, { healthReadiness: readiness });
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    await app.close();
    return { statusCode: response.statusCode, body: response.json() };
  }

  it('COMPATIBLE → 200', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const r = await healthStatusFor(catalog.entries.map((e) => e.version));
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ status: 'ok', releaseSha: 'dev' });
  });
  it('BEHIND → 503', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const r = await healthStatusFor(catalog.entries.filter((e) => e.number <= 36).map((e) => e.version));
    expect(r.statusCode).toBe(503);
    expect(r.body).toEqual({ status: 'unavailable', releaseSha: 'dev' });
  });
  it('AHEAD → 503', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const r = await healthStatusFor([...catalog.entries.map((e) => e.version), '044_future']);
    expect(r.statusCode).toBe(503);
  });
  it('DIVERGED → 503', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const r = await healthStatusFor([...catalog.entries.map((e) => e.version), '037_other_branch']);
    expect(r.statusCode).toBe(503);
  });
  it('missing table → 503', async () => {
    const err = Object.assign(new Error('relation "schema_migrations" does not exist'), { code: '42P01' });
    const r = await healthStatusFor(err);
    expect(r.statusCode).toBe(503);
  });
  it('DB unavailable → 503 without leaking host', async () => {
    const pool = {
      query: async () => {
        throw new Error('ECONNREFUSED secret-db-host');
      },
    } as unknown as Pool;
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const readiness = createPostgresReadiness(pool, catalog as never);
    const app = await buildApp(testConfig, { healthReadiness: readiness });
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    await app.close();
    expect(response.statusCode).toBe(503);
    expect(JSON.stringify(response.json())).not.toMatch(/secret-db-host/);
    expect(response.json()).toEqual({ status: 'unavailable', releaseSha: 'dev' });
  });
  it('public response does not expose migration internals', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const r = await healthStatusFor(catalog.entries.filter((e) => e.number <= 29).map((e) => e.version));
    const body = JSON.stringify(r.body);
    expect(body).not.toMatch(/037_staff|029_messaging|030|pending/i);
    expect(r.body).toEqual({ status: 'unavailable', releaseSha: 'dev' });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('SD2 disposable postgres acceptance', () => {
  const databaseUrl = process.env.TEST_DATABASE_URL as string;

  async function withSchema(fn: (pool: Pool, schema: string) => Promise<void>) {
    const admin = new Pool({ connectionString: databaseUrl });
    const schema = `sd2_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    try {
      await fn(pool, schema);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  }

  it('A: fully migrated → COMPATIBLE allowed', async () => {
    await withSchema(async (pool) => {
      const catalog = await loadMigrationCatalog(migrationsDirectory);
      const store = new PostgresMigrationStore(pool);
      await runMigrations({ migrationsDirectory, store });
      const { logger } = createMockLogger();
      await expect(assertStartupSchemaCompatible({ pool, catalog, logger })).resolves.toBeUndefined();
      const readiness = createPostgresReadiness(pool as never, catalog as never);
      await expect(readiness.check()).resolves.toBe('ok');
    });
  });

  it('B: one behind (036) → BEHIND refused', async () => {
    await withSchema(async (pool) => {
      const catalog = await loadMigrationCatalog(migrationsDirectory);
      const preDir = await mkdtemp(path.join(tmpdir(), 'sd2-pre36-'));
      tempDirs.push(preDir);
      for (const e of catalog.entries.filter((e) => e.number <= 36)) {
        const sql = await readFile(path.join(migrationsDirectory, e.filename), 'utf8');
        await writeFile(path.join(preDir, e.filename), sql, 'utf8');
      }
      const store = new PostgresMigrationStore(pool);
      await runMigrations({ migrationsDirectory: preDir, store });
      await expect(assertStartupSchemaCompatible({ pool, catalog })).rejects.toThrow(/BEHIND/);
      const readiness = createPostgresReadiness(pool as never, catalog as never);
      await expect(readiness.check()).resolves.toBe('unavailable');
    });
  });

  it('C: many behind (029 incident) → BEHIND refused', async () => {
    await withSchema(async (pool) => {
      const catalog = await loadMigrationCatalog(migrationsDirectory);
      const preDir = await mkdtemp(path.join(tmpdir(), 'sd2-pre29-'));
      tempDirs.push(preDir);
      for (const e of catalog.entries.filter((e) => e.number <= 29)) {
        const sql = await readFile(path.join(migrationsDirectory, e.filename), 'utf8');
        await writeFile(path.join(preDir, e.filename), sql, 'utf8');
      }
      const store = new PostgresMigrationStore(pool);
      await runMigrations({ migrationsDirectory: preDir, store });
      await expect(assertStartupSchemaCompatible({ pool, catalog })).rejects.toThrow(/BEHIND/);
    });
  });

  it('D: missing schema_migrations → refused', async () => {
    await withSchema(async (pool) => {
      const catalog = await loadMigrationCatalog(migrationsDirectory);
      // No migrations run, table missing
      await expect(assertStartupSchemaCompatible({ pool, catalog })).rejects.toThrow(/unavailable/);
      const readiness = createPostgresReadiness(pool as never, catalog as never);
      await expect(readiness.check()).resolves.toBe('unavailable');
    });
  });

  it('E: AHEAD synthetic 044_future refused', async () => {
    await withSchema(async (pool) => {
      const catalog = await loadMigrationCatalog(migrationsDirectory);
      const store = new PostgresMigrationStore(pool);
      await runMigrations({ migrationsDirectory, store });
      await pool.query("INSERT INTO schema_migrations (version) VALUES ('044_future')");
      await expect(assertStartupSchemaCompatible({ pool, catalog })).rejects.toThrow(/AHEAD/);
      const readiness = createPostgresReadiness(pool as never, catalog as never);
      await expect(readiness.check()).resolves.toBe('unavailable');
    });
  });

  it('F: DIVERGED synthetic 037_other_branch refused', async () => {
    await withSchema(async (pool) => {
      const catalog = await loadMigrationCatalog(migrationsDirectory);
      const store = new PostgresMigrationStore(pool);
      await runMigrations({ migrationsDirectory, store });
      await pool.query("INSERT INTO schema_migrations (version) VALUES ('037_other_branch')");
      await expect(assertStartupSchemaCompatible({ pool, catalog })).rejects.toThrow(/DIVERGED/);
      const readiness = createPostgresReadiness(pool as never, catalog as never);
      await expect(readiness.check()).resolves.toBe('unavailable');
    });
  });

  it('does not call initialize (read-only)', async () => {
    await withSchema(async (pool, schema) => {
      // No table created, fetch should fail without creating it
      const catalog = await loadMigrationCatalog(migrationsDirectory);
      const before = await pool
        .query("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'schema_migrations') as exists", [schema])
        .then((r) => (r.rows[0] as { exists: boolean }).exists);
      expect(before).toBe(false);
      await expect(assertStartupSchemaCompatible({ pool, catalog })).rejects.toThrow();
      const after = await pool
        .query("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'schema_migrations') as exists", [schema])
        .then((r) => (r.rows[0] as { exists: boolean }).exists);
      expect(after).toBe(false);
      // Ensure no advisory lock was taken (by checking that we can still run migrations)
      const store = new PostgresMigrationStore(pool);
      await expect(runMigrations({ migrationsDirectory, store })).resolves.toBeDefined();
    });
  });
});

describe('SD2 catalog invalid & missing', () => {
  it('catalog invalid fails startup', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bad-cat-'));
    tempDirs.push(dir);
    await writeFile(path.join(dir, '001_first.sql'), 'SELECT 1');
    await writeFile(path.join(dir, '001_dup.sql'), 'SELECT 1');
    await expect(loadMigrationCatalog(dir)).rejects.toMatchObject({ code: 'CATALOG_INVALID' });
  });
  it('missing migrations directory fails', async () => {
    await expect(loadMigrationCatalog('/nonexistent/migrations')).rejects.toThrow();
  });
});
