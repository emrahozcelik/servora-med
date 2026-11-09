import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { compareMigrationState, loadMigrationCatalog, type MigrationCatalog } from '../src/db/migration-catalog.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { assertStartupSchemaCompatible, checkDatabaseSchemaCompatibility } from '../src/db/schema-compatibility.js';
import { createPostgresReadiness } from '../src/modules/health/postgres-readiness.js';
import { validateRestoredDatabase } from '../src/modules/backup/restore/postgres.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `migration_order_${randomUUID().replaceAll('-', '')}`;
const admin = url ? new Pool({ connectionString: url }) : null;
const pool = url ? new Pool({ connectionString: url, options: `-c search_path=${schema},public` }) : null;
const release = fileURLToPath(new URL('../../', import.meta.url));
const migrations = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const deployProbe = path.join(release, 'ops/scripts/migration-state.mjs');
let catalog: MigrationCatalog;
let previousRelease: string;

function cli(script: string, args: string[] = []) {
  const databaseUrl = new URL(url!);
  databaseUrl.searchParams.set('options', `-c search_path=${schema},public`);
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl.toString(), HEALTH_SCHEMA_VERSION: undefined },
  });
}

async function history() {
  return (await pool!.query('SELECT version, applied_at, xmin::text FROM schema_migrations ORDER BY version ASC')).rows;
}

async function expectIncompatibleReaders(expected: 'BEHIND' | 'AHEAD' | 'DIVERGED' | 'EMPTY', deployStatus: string,
  targetCatalog = catalog, targetRelease = release) {
  const before = await history();
  const applied = await new PostgresMigrationStore(pool!).getAppliedVersions();
  expect(compareMigrationState(targetCatalog, applied).status).toBe(expected);
  expect((await checkDatabaseSchemaCompatibility({ pool: pool!, catalog: targetCatalog })).status).toBe(expected);
  await expect(assertStartupSchemaCompatible({ pool: pool!, catalog: targetCatalog })).rejects.toThrow(expected);
  expect(await createPostgresReadiness(pool!, targetCatalog).check()).toBe('unavailable');
  const startup = cli(path.join(targetRelease, 'server/dist/db/schema-check.js'));
  expect(startup.error).toBeUndefined();
  expect(startup.status).toBe(1);
  expect(startup.stderr).toContain(`Schema check: ${expected}`);
  const deploy = cli(deployProbe, [targetRelease]);
  // The probe returns classification data; its caller enforces the deploy gate.
  expect(deploy.error).toBeUndefined();
  expect(deploy.status).toBe(0);
  expect(deploy.stdout).toContain(`migration_status=${deployStatus}\n`);
  expect(deploy.stdout).toContain('exact_catalog=false\n');
  expect(deploy.stdout + deploy.stderr).not.toContain('postgresql://');
  expect(await history()).toEqual(before);
  return deploy.stdout;
}

beforeAll(async () => {
  if (!pool || !admin) return;
  await admin.query(`CREATE SCHEMA ${schema}`);
  catalog = await loadMigrationCatalog(migrations);
  await runMigrations({ migrationsDirectory: migrations, store: new PostgresMigrationStore(pool) });
  // A disposable 055 release catalog models the pre-056 application's guard.
  previousRelease = await mkdtemp(path.join(tmpdir(), 'servora-order-055-'));
  await mkdir(path.join(previousRelease, 'server'), { recursive: true });
  await cp(path.join(release, 'server/dist'), path.join(previousRelease, 'server/dist'), { recursive: true });
  await writeFile(path.join(previousRelease, 'server/package.json'), '{"type":"module"}\n');
  await symlink(path.join(release, 'server/node_modules'), path.join(previousRelease, 'server/node_modules'), 'dir');
  await rm(path.join(previousRelease, 'server/dist/db/migrations/056_meeting_met_contact.sql'));
  await rm(path.join(previousRelease, 'server/dist/db/migrations/057_sale_from_visit.sql'));
  await rm(path.join(previousRelease, 'server/dist/db/migrations/058_sale_integer_quantity.sql'));
  await rm(path.join(previousRelease, 'server/dist/db/migrations/059_crm_duplicate_read_indexes.sql'));
  await rm(path.join(previousRelease, 'server/dist/db/migrations/060_crm_duplicate_review_decisions.sql'));
  await rm(path.join(previousRelease, 'server/dist/db/migrations/061_weekly_report_removal.sql'));
});

beforeEach(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM schema_migrations');
  // Alternate timestamps deliberately interleave adjacent canonical versions.
  await pool.query(`INSERT INTO schema_migrations (version, applied_at)
    SELECT version, TIMESTAMPTZ '2026-07-01 00:00:00+00'
      + ((CASE WHEN ordinal % 2 = 0 THEN 1000 - ordinal ELSE ordinal END) * INTERVAL '1 second')
    FROM unnest($1::text[]) WITH ORDINALITY AS versions(version, ordinal)`,
  [catalog.entries.map((entry) => entry.version)]);
});

afterAll(async () => {
  if (previousRelease) await rm(previousRelease, { recursive: true, force: true });
  await pool?.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

describe.skipIf(!url)('migration reader ordering — disposable PostgreSQL', () => {
  it('accepts the same complete 060 history despite interleaved timestamps in every reader', async () => {
    const before = await history();
    const applied = await new PostgresMigrationStore(pool!).getAppliedVersions();
    expect(applied).toEqual(catalog.entries.map((entry) => entry.version));
    expect(compareMigrationState(catalog, applied).status).toBe('COMPATIBLE');
    expect((await checkDatabaseSchemaCompatibility({ pool: pool!, catalog })).status).toBe('COMPATIBLE');
    await expect(assertStartupSchemaCompatible({ pool: pool!, catalog })).resolves.toBeUndefined();
    expect(await createPostgresReadiness(pool!, catalog).check()).toBe('ok');
    const restoredUrl = new URL(url!);
    restoredUrl.searchParams.set('options', `-c search_path=${schema},public`);
    await expect(validateRestoredDatabase(restoredUrl.toString(), {
      database: { engine: 'postgresql', serverVersion: '17', dumpVersion: 'synthetic',
        dumpToolVersion: '17', schemaVersion: catalog.head!.version },
    }, catalog)).resolves.toMatchObject({ schemaVersion: catalog.head!.version });
    const startup = cli(path.join(release, 'server/dist/db/schema-check.js'));
    expect(startup.error).toBeUndefined();
    expect(startup.status).toBe(0);
    expect(startup.stdout).toContain('Schema check: COMPATIBLE');
    const deploy = cli(deployProbe, [release]);
    expect(deploy.error).toBeUndefined();
    expect(deploy.status).toBe(0);
    expect(deploy.stdout).toContain('migration_status=EXACT\n');
    expect(deploy.stdout).toContain('applied_count=61\n');
    expect(deploy.stdout).toContain('pending_count=0\n');
    expect(deploy.stdout).toContain('unexpected_count=0\n');
    expect(await history()).toEqual(before);
  });

  it('reports 060 as BEHIND with only 061 pending despite interleaved timestamps', async () => {
    await pool!.query('DELETE FROM schema_migrations WHERE version = $1', [catalog.head!.version]);
    const output = await expectIncompatibleReaders('BEHIND', 'PREFIX_WITH_PENDING');
    expect(output).toContain('pending_count=1\n');
    expect(output).toContain('pending_versions=061_weekly_report_removal\n');
    expect(output).toContain('applied_head=060_crm_duplicate_review_decisions\n');
  });

  it('reports a synthetic future canonical version as AHEAD in all readers', async () => {
    await pool!.query("INSERT INTO schema_migrations (version, applied_at) VALUES ('062_future_feature', '2000-01-01')");
    const output = await expectIncompatibleReaders('AHEAD', 'DATABASE_AHEAD');
    expect(output).toContain('unexpected_versions=062_future_feature\n');
  });

  it('keeps a missing middle migration DIVERGED', async () => {
    await pool!.query('DELETE FROM schema_migrations WHERE version = $1', [catalog.entries[24]!.version]);
    await expectIncompatibleReaders('DIVERGED', 'DIVERGENT');
  });

  it('keeps an alternative branch migration DIVERGED', async () => {
    await pool!.query("UPDATE schema_migrations SET version = '061_alternative_branch' WHERE version = $1", [catalog.head!.version]);
    await expectIncompatibleReaders('DIVERGED', 'DIVERGENT');
  });

  it('rejects duplicate version numbers even when identifiers differ', async () => {
    await pool!.query("INSERT INTO schema_migrations (version) VALUES ('056_alternative_branch')");
    await expectIncompatibleReaders('DIVERGED', 'DUPLICATE_HISTORY');
  });

  it('rejects invalid versions without copying them into deployment output', async () => {
    await pool!.query("INSERT INTO schema_migrations (version) VALUES ('000 invalid version')");
    const output = await expectIncompatibleReaders('DIVERGED', 'DIVERGENT');
    expect(output).not.toContain('000 invalid version');
    expect(output).toContain('INVALID');
  });

  it('keeps empty history incompatible and reports every version pending', async () => {
    await pool!.query('DELETE FROM schema_migrations');
    const output = await expectIncompatibleReaders('EMPTY', 'PREFIX_WITH_PENDING');
    expect(output).toContain('pending_count=61\n');
  });

  it('keeps the pre-056 release catalog AHEAD fail-closed against a 061 database', async () => {
    const previousCatalog = await loadMigrationCatalog(path.join(previousRelease, 'server/dist/db/migrations'));
    expect(previousCatalog.head!.version).toBe('055_job_submit_location_comparison');
    const output = await expectIncompatibleReaders('AHEAD', 'DATABASE_AHEAD', previousCatalog, previousRelease);
    expect(output).toContain('unexpected_versions=056_meeting_met_contact,057_sale_from_visit,058_sale_integer_quantity,059_crm_duplicate_read_indexes,060_crm_duplicate_review_decisions,061_weekly_report_removal\n');
  });
});
