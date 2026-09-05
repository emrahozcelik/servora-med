/**
 * First-deploy bootstrap ordering regression.
 *
 * Production Deploy run 33940068964 failed with MIGRATION_FAILED because the
 * candidate migrate.js imported full application loadConfig(), which requires
 * SERVORA_RELEASE_SHA in production — but the legacy production env does not
 * contain that key until the host helper transitions it AFTER migration.
 *
 * The migration CLI is a database maintenance tool: it must bootstrap from
 * DATABASE_URL alone. These tests execute the BUILT dist entrypoint (the same
 * artifact shape production runs) with NODE_ENV=production and
 * SERVORA_RELEASE_SHA absent.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';

const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const migrateDist = fileURLToPath(new URL('../dist/db/migrate.js', import.meta.url));

type DistResult = { exitCode: number; stdout: string; stderr: string };

function runMigrateDist(env: NodeJS.ProcessEnv): DistResult {
  try {
    const stdout = execFileSync(process.execPath, [migrateDist], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(err.message ?? ''),
    };
  }
}

/**
 * Legacy first-deploy environment: production, valid DATABASE_URL, and
 * explicitly NO release identity — mirroring /etc/servora-med/servora-med.env
 * before the host helper transitions SERVORA_RELEASE_SHA.
 */
function legacyProdEnv(databaseUrl: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { SERVORA_RELEASE_SHA: _absent, ...rest } = process.env;
  void _absent;
  return {
    ...rest,
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl,
    ...extra,
  };
}

async function withDisposableSchema(
  fn: (dbUrl: string) => Promise<void>,
): Promise<void> {
  const adminUrl = process.env.TEST_DATABASE_URL as string;
  const admin = new Pool({ connectionString: adminUrl });
  const schema = `sc_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const urlObj = new URL(adminUrl);
  urlObj.searchParams.set('options', `-c search_path=${schema}`);
  const dbUrl = urlObj.toString();
  try {
    await fn(dbUrl);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

async function migrateToHead(dbUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const store = new PostgresMigrationStore(pool);
    await runMigrations({ migrationsDirectory, store });
  } finally {
    await pool.end();
  }
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('migrate bootstrap without release SHA', () => {
  it('no-op at catalog head with NODE_ENV=production and SHA absent', async () => {
    await withDisposableSchema(async (dbUrl) => {
      await migrateToHead(dbUrl);
      const result = runMigrateDist(legacyProdEnv(dbUrl));
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).not.toMatch(/SERVORA_RELEASE_SHA/);
      const pool = new Pool({ connectionString: dbUrl });
      try {
        const catalog = await loadMigrationCatalog(migrationsDirectory);
        const store = new PostgresMigrationStore(pool);
        const applied = await store.getAppliedVersions();
        expect(applied.length).toBe(catalog.count);
      } finally {
        await pool.end();
      }
    });
  });

  it('applies pending migrations with SHA absent', async () => {
    await withDisposableSchema(async (dbUrl) => {
      const result = runMigrateDist(legacyProdEnv(dbUrl));
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).not.toMatch(/SERVORA_RELEASE_SHA/);
      const pool = new Pool({ connectionString: dbUrl });
      try {
        const catalog = await loadMigrationCatalog(migrationsDirectory);
        const store = new PostgresMigrationStore(pool);
        const applied = await store.getAppliedVersions();
        expect(applied.length).toBe(catalog.count);
      } finally {
        await pool.end();
      }
    });
  });

  it('needs only DATABASE_URL: ignores unrelated missing runtime config', async () => {
    await withDisposableSchema(async (dbUrl) => {
      await migrateToHead(dbUrl);
      const { CORS_ORIGIN: _c, HOST: _h, PORT: _p, HEALTH_SCHEMA_VERSION: _v, ...rest } = process.env;
      void _c;
      void _h;
      void _p;
      void _v;
      const result = runMigrateDist({
        ...rest,
        NODE_ENV: 'production',
        DATABASE_URL: dbUrl,
      });
      expect(result.exitCode).toBe(0);
    });
  });

  it('still rejects invalid DATABASE_URL without leaking secrets', async () => {
    const secretUrl = 'postgresql://svc:super-secret-pw@localhost:5432/db';
    const result = runMigrateDist(legacyProdEnv('not-a-database-url'));
    expect(result.exitCode).not.toBe(0);
    const badScheme = runMigrateDist(legacyProdEnv(secretUrl.replace('postgresql://', 'mysql://')));
    expect(badScheme.exitCode).not.toBe(0);
    expect(badScheme.stdout + badScheme.stderr).not.toContain('super-secret-pw');
    const missing = runMigrateDist((() => {
      const env = legacyProdEnv('postgresql://localhost:5432/unused');
      delete env.DATABASE_URL;
      return env;
    })());
    expect(missing.exitCode).not.toBe(0);
  });
});
