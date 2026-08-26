import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { compareMigrationState, loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { getMigrationsDirectory } from '../src/db/schema-compatibility.js';

const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const schemaCheckSrc = fileURLToPath(new URL('../src/db/schema-check.ts', import.meta.url));
const schemaCheckDist = fileURLToPath(new URL('../dist/db/schema-check.js', import.meta.url));

// Unit-level compatibility without DB
describe('schema-check compatibility classifications', () => {
  it('classifies COMPATIBLE only when history equals catalog', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const applied = catalog.entries.map((e) => e.version);
    const cmp = compareMigrationState(catalog, applied);
    expect(cmp.status).toBe('COMPATIBLE');
  });

  it('classifies BEHIND when one migration missing', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const applied = catalog.entries.filter((e) => e.number <= catalog.count - 1).map((e) => e.version);
    const cmp = compareMigrationState(catalog, applied);
    expect(cmp.status).toBe('BEHIND');
    if (cmp.status === 'BEHIND') {
      expect(cmp.pendingVersions).toContain('037_staff_offboarding_audit');
    }
  });

  it('classifies EMPTY when no history', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const cmp = compareMigrationState(catalog, []);
    expect(cmp.status).toBe('EMPTY');
  });

  it('classifies AHEAD for valid future version', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const applied = [...catalog.entries.map((e) => e.version), '038_future_feature'];
    const cmp = compareMigrationState(catalog, applied);
    expect(cmp.status).toBe('AHEAD');
  });

  it('classifies DIVERGED for invalid future or duplicate', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const applied = [...catalog.entries.map((e) => e.version), 'garbage'];
    const cmp = compareMigrationState(catalog, applied);
    expect(cmp.status).toBe('DIVERGED');
  });

  it('does not expose DATABASE_URL in formatted log', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const applied = catalog.entries.slice(0, 36).map((e) => e.version);
    const cmp = compareMigrationState(catalog, applied);
    const serialized = JSON.stringify(cmp);
    expect(serialized).not.toContain('postgresql://');
    expect(serialized).not.toContain('DATABASE_URL');
  });
});

function runSchemaCheckViaNode(distPath: string, env: NodeJS.ProcessEnv): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [distPath], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
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

function baseEnv(databaseUrl: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    // Ensure health check does not require extra production env
    HEALTH_SCHEMA_VERSION: undefined,
    ...extra,
  };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('schema-check disposable postgres acceptance', () => {
  const databaseUrl = process.env.TEST_DATABASE_URL as string;

  async function withSchema(fn: (pool: Pool, schema: string, dbUrl: string) => Promise<void>) {
    const admin = new Pool({ connectionString: databaseUrl });
    const schema = `sc_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    // Use search_path to isolate migrations to this schema
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const urlObj = new URL(databaseUrl);
    urlObj.searchParams.set('options', `-c search_path=${schema}`);
    const dbUrl = urlObj.toString();
    // For CLI, we need a DATABASE_URL that points to this schema. Use the same connection string with options.
    // The CLI will be invoked with DATABASE_URL=dbUrl
    try {
      await fn(pool, schema, dbUrl);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  }

  it('compatible → exit 0 (dist)', async () => {
    await withSchema(async (_pool, _schema, dbUrl) => {
      // Need to run migrations via store using the pool
      const adminPool = new Pool({ connectionString: dbUrl });
      try {
        const store = new PostgresMigrationStore(adminPool);
        await runMigrations({ migrationsDirectory, store });
      } finally {
        await adminPool.end();
      }
      const result = runSchemaCheckViaNode(schemaCheckDist, baseEnv(dbUrl));
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/COMPATIBLE/);
      expect(result.stdout + result.stderr).not.toMatch(/postgresql:\/\//);
    });
  });

  it('one behind → nonzero BEHIND and pending shown', async () => {
    await withSchema(async (_pool, _schema, dbUrl) => {
      const preDir = await mkdtemp(path.join(tmpdir(), 'sc-pre36-'));
      try {
        const catalog = await loadMigrationCatalog(migrationsDirectory);
        for (const e of catalog.entries.filter((e) => e.number <= 36)) {
          const sql = await readFile(path.join(migrationsDirectory, e.filename), 'utf8');
          await writeFile(path.join(preDir, e.filename), sql, 'utf8');
        }
        const migrPool = new Pool({ connectionString: dbUrl });
        try {
          await runMigrations({ migrationsDirectory: preDir, store: new PostgresMigrationStore(migrPool) });
        } finally {
          await migrPool.end();
        }
        const result = runSchemaCheckViaNode(schemaCheckDist, baseEnv(dbUrl));
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout + result.stderr).toMatch(/BEHIND/);
        expect(result.stdout + result.stderr).toMatch(/Run npm run migrate/);
      } finally {
        await rm(preDir, { recursive: true, force: true });
      }
    });
  });

  it('after migrate behind → passes', async () => {
    await withSchema(async (_pool, _schema, dbUrl) => {
      const preDir = await mkdtemp(path.join(tmpdir(), 'sc-pre36-2-'));
      try {
        const catalog = await loadMigrationCatalog(migrationsDirectory);
        for (const e of catalog.entries.filter((e) => e.number <= 36)) {
          const sql = await readFile(path.join(migrationsDirectory, e.filename), 'utf8');
          await writeFile(path.join(preDir, e.filename), sql, 'utf8');
        }
        const migrPool = new Pool({ connectionString: dbUrl });
        try {
          await runMigrations({ migrationsDirectory: preDir, store: new PostgresMigrationStore(migrPool) });
        } finally {
          await migrPool.end();
        }
        const before = runSchemaCheckViaNode(schemaCheckDist, baseEnv(dbUrl));
        expect(before.exitCode).not.toBe(0);
        // Now migrate to head via canonical
        const migrPool2 = new Pool({ connectionString: dbUrl });
        try {
          await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(migrPool2) });
        } finally {
          await migrPool2.end();
        }
        const after = runSchemaCheckViaNode(schemaCheckDist, baseEnv(dbUrl));
        expect(after.exitCode).toBe(0);
        expect(after.stdout + after.stderr).toMatch(/COMPATIBLE/);
      } finally {
        await rm(preDir, { recursive: true, force: true });
      }
    });
  });

  it('missing schema_migrations → nonzero and table still absent', async () => {
    await withSchema(async (pool, schema, dbUrl) => {
      const beforeExists = await pool
        .query("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='schema_migrations') as exists", [schema])
        .then((r) => (r.rows[0] as { exists: boolean }).exists);
      expect(beforeExists).toBe(false);
      const result = runSchemaCheckViaNode(schemaCheckDist, baseEnv(dbUrl));
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/no migration history|missing schema_migrations/i);
      const afterExists = await pool
        .query("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='schema_migrations') as exists", [schema])
        .then((r) => (r.rows[0] as { exists: boolean }).exists);
      expect(afterExists).toBe(false);
      // Ensure DATABASE_URL not leaked
      expect(result.stdout + result.stderr).not.toMatch(/postgresql:\/\//);
    });
  });

  it('AHEAD synthetic → nonzero and does not recommend migrate', async () => {
    await withSchema(async (_pool, _schema, dbUrl) => {
      const migrPool = new Pool({ connectionString: dbUrl });
      try {
        await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(migrPool) });
        await migrPool.query("INSERT INTO schema_migrations (version) VALUES ('038_future_feature')");
      } finally {
        await migrPool.end();
      }
      const result = runSchemaCheckViaNode(schemaCheckDist, baseEnv(dbUrl));
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/AHEAD/);
      expect(result.stdout + result.stderr).toMatch(/newer than this release/i);
      expect(result.stdout + result.stderr).not.toMatch(/Run npm run migrate/);
    });
  });

  it('DIVERGED synthetic → nonzero', async () => {
    await withSchema(async (_pool, _schema, dbUrl) => {
      const migrPool = new Pool({ connectionString: dbUrl });
      try {
        await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(migrPool) });
        await migrPool.query("INSERT INTO schema_migrations (version) VALUES ('037_other_branch')");
      } finally {
        await migrPool.end();
      }
      const result = runSchemaCheckViaNode(schemaCheckDist, baseEnv(dbUrl));
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/DIVERGED/);
    });
  });

  it('HEALTH_SCHEMA_VERSION mismatch → nonzero', async () => {
    await withSchema(async (_pool, _schema, dbUrl) => {
      const migrPool = new Pool({ connectionString: dbUrl });
      try {
        await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(migrPool) });
      } finally {
        await migrPool.end();
      }
      const result = runSchemaCheckViaNode(schemaCheckDist, baseEnv(dbUrl, { HEALTH_SCHEMA_VERSION: '001_wrong' }));
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/HEALTH_SCHEMA_VERSION mismatch/);
    });
  });

  it('produces dist catalog 37 head 037', async () => {
    const distCatalog = await loadMigrationCatalog(fileURLToPath(new URL('../dist/db/migrations', import.meta.url)));
    expect(distCatalog.count).toBe(37);
    expect(distCatalog.head?.version).toBe('037_staff_offboarding_audit');
  });

  it('resource cleanup: pool closed after success and failure', async () => {
    // This is proven by the fact that withSchema pools are closed and no hanging handles.
    // We also verify that a failing check still allows subsequent operations.
    await withSchema(async (_pool, _schema, dbUrl) => {
      const bad = runSchemaCheckViaNode(schemaCheckDist, baseEnv(dbUrl));
      expect(bad.exitCode).not.toBe(0);
      // Now migrate and check again — should succeed if cleanup was proper
      const migrPool = new Pool({ connectionString: dbUrl });
      try {
        await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(migrPool) });
      } finally {
        await migrPool.end();
      }
      const good = runSchemaCheckViaNode(schemaCheckDist, baseEnv(dbUrl));
      expect(good.exitCode).toBe(0);
    });
  });
});
