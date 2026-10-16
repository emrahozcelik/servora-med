import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresMigrationStore } from '../src/db/index.js';
import { compareMigrationState, loadMigrationCatalog, type MigrationCatalog } from '../src/db/migration-catalog.js';
import { loadInstalledRecoveryCatalog } from '../src/db/recovery-catalog.js';
import { restoreDumpIntoNewDatabase, dropRestoreTargetIfCreated } from '../src/modules/backup/restore/postgres.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { validateRestoredDatabase } from '../src/modules/backup/restore/postgres.js';
import type { RestoreManifestV1 } from '../src/modules/backup/restore/manifest.js';
import { RestoreService } from '../src/modules/backup/restore/service.js';
import { createRecoveryReleaseFixture } from './helpers/recovery-release-fixture.js';

const url = process.env.TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const script = process.env.RECOVERY_SAFETY_SCRIPT ?? fileURLToPath(new URL('../../ops/scripts/production-recovery.sh', import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'servora-recovery-safety-'));
const admin = url ? new Pool({ connectionString: url }) : null;
const created: string[] = [];
let catalog: MigrationCatalog;
let oldCatalog: MigrationCatalog;
const oldSha = 'a'.repeat(40);
const newSha = 'c'.repeat(40);
let releaseRoot: string;
let seed55: string;
let seed56: string;

function dbUrl(database: string) { const value = new URL(url!); value.pathname = `/${database}`; return value.toString(); }
async function createDatabase(template?: string) {
  const name = `servora_med_test_recovery_${randomUUID().replaceAll('-', '')}`;
  await admin!.query(`CREATE DATABASE ${name}${template ? ` TEMPLATE ${template}` : ''}`);
  created.push(name); return name;
}
function command(bin: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(bin, args, { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 });
}
function pgEnv(database: string) {
  const value = new URL(url!);
  return { PGHOST: value.hostname, PGPORT: value.port || '5432', PGUSER: decodeURIComponent(value.username),
    PGPASSWORD: decodeURIComponent(value.password), PGDATABASE: database };
}
function manifest(head: string): RestoreManifestV1 {
  return { format: 'servora-backup', formatVersion: 1, backupId: randomUUID(), createdAt: '2026-10-11T00:00:00Z',
    application: { applicationVersion: '0.1.0', gitCommit: null }, backupScope: 'DATABASE', origin: 'MANUAL',
    retentionClass: 'MANUAL', database: { engine: 'postgresql', serverVersion: '17.11', dumpVersion: '1.16',
      dumpToolVersion: '17.11', schemaVersion: head }, contents: { database: { file: 'database.dump', bytes: 1,
        sha256: 'a'.repeat(64) }, files: null }, checksums: { file: 'checksums.sha256' } };
}
async function snapshot(pool: Pool) {
  const tables = (await pool.query<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const rows: Record<string, unknown> = {};
  for (const { name } of tables) rows[name] = (await pool.query(`SELECT to_jsonb(t)::text AS row FROM "${name}" t ORDER BY 1`)).rows;
  const constraints = (await pool.query("SELECT conrelid::regclass::text AS relation, conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2")).rows;
  const indexes = (await pool.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2")).rows;
  const sequences: Record<string, unknown> = {};
  for (const { sequencename } of (await pool.query<{ sequencename: string }>("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows) {
    sequences[sequencename] = (await pool.query(`SELECT last_value::text,is_called FROM "${sequencename}"`)).rows;
  }
  const columns = (await pool.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
  const functions = (await pool.query("SELECT oid::regprocedure::text AS signature,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind IN ('f','p') ORDER BY 1")).rows;
  return { rows, constraints, indexes, sequences, columns, functions };
}
async function withPool(database: string, fn: (pool: Pool) => Promise<void>) {
  const pool = new Pool({ connectionString: dbUrl(database) });
  try { await fn(pool); } finally { await pool.end(); }
}
async function restoredSnapshot(file: string) {
  const database = await createDatabase();
  const result = command('pg_restore', ['--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', '--dbname', database, file], pgEnv(database));
  expect(result.status, result.stderr).toBe(0);
  const pool = new Pool({ connectionString: dbUrl(database) });
  try { return await snapshot(pool); } finally { await pool.end(); }
}
function dump(database: string, label: string) {
  const file = path.join(root, `servora-med-${label}.dump`);
  const result = command('pg_dump', ['-Fc', '--no-owner', '--no-acl', '--file', file], pgEnv(database));
  expect(result.status, result.stderr).toBe(0);
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  writeFileSync(`${file}.sha256`, `${hash}  ${path.basename(file)}\n`);
  return file;
}
function recover(database: string, file: string, label: string) {
  const envFile = path.join(root, `${label}.env`);
  writeFileSync(envFile, 'HEALTH_SCHEMA_VERSION=058_sale_integer_quantity\nOTHER=preserve\n'); chmodSync(envFile, 0o600);
  const result = command('bash', [script, '--backup', file, '--checksum', `${file}.sha256`, '--target-db', 'servora_med',
    '--expected-host', '127.0.0.1', '--allow-destructive', '--old-release', oldSha,
    '--old-health-schema-version', oldCatalog.head!.version, '--env-file', envFile], {
    TEST_DATABASE_URL: dbUrl(database), OPS_LOG: path.join(root, `${label}.ops.log`),
    PG_RESTORE_BIN: process.env.PG_RESTORE_BIN ?? 'pg_restore', PSQL_BIN: process.env.PSQL_BIN ?? 'psql',
    RECOVERY_RELEASES_ROOT: releaseRoot,
    NODE_BIN: process.execPath,
  });
  console.log(`RECOVERY_TEST ${label} exit=${result.status}\n${result.stdout}${result.stderr}`);
  return { ...result, output: result.stdout + result.stderr, env: readFileSync(envFile, 'utf8') };
}
function releaseFixture(sha: string, entries: MigrationCatalog['entries']) {
  return createRecoveryReleaseFixture(releaseRoot, sha, entries);
}
function packageFixture(database: string, label: string, head: string) {
  const file = dump(database, label); const bytes = readFileSync(file);
  const directory = path.join(root, label); mkdirSync(directory);
  const data = manifest(head);
  data.contents.database.bytes = bytes.length;
  data.contents.database.sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(path.join(directory, 'database.dump'), bytes);
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(data));
  writeFileSync(path.join(directory, 'checksums.sha256'), `${data.contents.database.sha256}  database.dump\n`);
  const archive = path.join(root, `${label}.sbk.tar`);
  const result = command('tar', ['-cf', archive, '-C', directory, 'manifest.json', 'database.dump', 'checksums.sha256']);
  expect(result.status, result.stderr).toBe(0); return archive;
}

beforeAll(async () => {
  if (!admin) return;
  catalog = await loadMigrationCatalog(migrations);
  releaseRoot = path.join(root, 'releases');
  const directory = releaseFixture(oldSha, catalog.entries.filter((entry) => entry.number < 56));
  releaseFixture(newSha, catalog.entries);
  vi.stubEnv('RECOVERY_RELEASES_ROOT', releaseRoot);
  oldCatalog = await loadMigrationCatalog(directory);
  seed55 = await createDatabase(); seed56 = await createDatabase();
  for (const [database, directory] of [[seed55, oldCatalog.directory], [seed56, migrations]]) {
    const pool = new Pool({ connectionString: dbUrl(database) });
    try {
      await runMigrations({ migrationsDirectory: directory, store: new PostgresMigrationStore(pool) });
      await pool.query("INSERT INTO organizations(name,timezone) VALUES('Synthetic recovery organization','Europe/Istanbul'),('Synthetic foreign organization','Europe/Istanbul')");
      await pool.query("INSERT INTO users(organization_id,name,email,password_hash,role) SELECT id,'Synthetic STAFF',id::text || '@recovery.invalid','synthetic-hash','STAFF' FROM organizations");
      await pool.query("INSERT INTO customers(organization_id,name,customer_type,status) SELECT id,'Synthetic customer','clinic','active' FROM organizations");
      await pool.query("INSERT INTO contacts(organization_id,customer_id,name,is_primary) SELECT organization_id,id,'Synthetic contact',true FROM customers");
      await pool.query("INSERT INTO job_cards(organization_id,type,title,customer_id,contact_id,assigned_to,created_by,engagement_kind) SELECT c.organization_id,'SALES_MEETING','Synthetic meeting',c.id,ct.id,u.id,u.id,'SALES_MEETING' FROM customers c JOIN contacts ct ON ct.customer_id=c.id JOIN users u ON u.organization_id=c.organization_id");
      await pool.query("INSERT INTO job_card_meeting_details(job_card_id,organization_id,meeting_summary) SELECT id,organization_id,'Synthetic existing meeting' FROM job_cards");
      await pool.query("INSERT INTO job_card_activity_logs(organization_id,job_card_id,actor_id,event_type) SELECT organization_id,id,created_by,'JOB_CREATED' FROM job_cards");
      await pool.query("INSERT INTO audit_events(organization_id,actor_user_id,subject_type,subject_id,event_type) SELECT organization_id,id,'USER',id,'USER_CREATED' FROM users");
    } finally { await pool.end(); }
  }
}, 60_000);
afterAll(async () => {
  if (admin) { for (const name of created.reverse()) await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.end(); }
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!url)('recovery safety — actual PostgreSQL and public recovery paths', () => {
  it('R1 rejects a 055 dump over a 056 target before any target mutation', async () => {
    const target = await createDatabase(seed56);
    await withPool(target, async (pool) => {
      const before = await snapshot(pool); const file = dump(seed55, 'cross-schema');
      const result = recover(target, file, 'cross-schema');
      const after = await snapshot(pool);
      console.log(`R1_CONSTRAINTS before=${before.constraints.length} after=${after.constraints.length}`);
      // Snapshot is checked first: this exposes the legacy partial constraint loss.
      expect(after).toEqual(before);
      expect(result.status).not.toBe(0); expect(result.output).not.toContain('RECOVERY=PASS');
      expect(result.output).toContain('RECOVERY_HISTORY_AHEAD');
      expect(result.env).toContain('HEALTH_SCHEMA_VERSION=058_sale_integer_quantity');
    });
  });
  it('R2 accepts exact 056 history with deliberately interleaved timestamps', async () => {
    const target = await createDatabase(seed56);
    await withPool(target, async (pool) => {
      await pool.query("UPDATE schema_migrations SET applied_at=CASE WHEN version LIKE '050_%' THEN '2099-01-01'::timestamptz ELSE '2020-01-01'::timestamptz END");
      const before = await snapshot(pool);
      await expect(validateRestoredDatabase(dbUrl(target), manifest(catalog.head!.version), catalog)).resolves.toMatchObject({ schemaVersion: catalog.head!.version });
      expect(await snapshot(pool)).toEqual(before);
    });
  });
  it('R3 rejects a missing-middle history even when the manifest head matches', async () => {
    const target = await createDatabase(seed56);
    await withPool(target, async (pool) => {
      await pool.query("DELETE FROM schema_migrations WHERE version LIKE '030_%'");
      await pool.query("UPDATE schema_migrations SET applied_at='2020-01-01'::timestamptz");
      const before = await snapshot(pool);
      await expect(validateRestoredDatabase(dbUrl(target), manifest(catalog.head!.version), catalog)).rejects.toThrow();
      expect(await snapshot(pool)).toEqual(before);
    });
  });
  it('R1 preserves supported same-schema restore with a verified installed catalog', async () => {
    const target = await createDatabase(seed55);
    const file = dump(seed55, 'same-schema');
    await withPool(seed55, async (source) => {
      const original = await snapshot(source);
      // pg_dump/restore may canonicalize equivalent CHECK expression syntax.
      // Compare definitions with an independent restore of this exact dump,
      // while requiring original rows and constraint identities to survive.
      const expected = await restoredSnapshot(file);
      expect(expected.rows).toEqual(original.rows);
      expect(expected.constraints.map(({ relation, conname }) => ({ relation, conname })))
        .toEqual(original.constraints.map(({ relation, conname }) => ({ relation, conname })));
      const result = recover(target, file, 'same-schema');
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('RECOVERY_PREFLIGHT_PASS');
      expect(result.output).toContain('RECOVERY=PASS');
      expect(result.env).toContain(`HEALTH_SCHEMA_VERSION=${oldCatalog.head!.version}`);
      await withPool(target, async (pool) => { expect(await snapshot(pool)).toEqual(expected); });
    });
  }, 30_000);
  it('R1 rolls back every clean/drop operation on a controlled mid-restore failure', async () => {
    const target = await createDatabase(seed55); const file = dump(seed55, 'atomic-failure');
    await withPool(target, async (pool) => {
      // This target-only dependency fails CLEAN after earlier drops. The dump
      // itself restores successfully in the preflight scratch database.
      await pool.query('CREATE TABLE recovery_blocker (organization_id uuid, contact_id uuid, FOREIGN KEY(organization_id,contact_id) REFERENCES contacts(organization_id,id))');
      const before = await snapshot(pool);
      const result = recover(target, file, 'atomic-failure');
      expect(result.output).toContain('RECOVERY_PREFLIGHT_PASS');
      expect(result.status, result.output).toBe(5);
      expect(result.output).toContain('RESTORE_FAILED');
      expect(result.output).not.toContain('RECOVERY=PASS');
      expect(await snapshot(pool)).toEqual(before);
      expect(result.env).toContain('HEALTH_SCHEMA_VERSION=058_sale_integer_quantity');
    });
  });
  it('R1 rolls back late post-data failure including sequence values and schema metadata', async () => {
    const source = await createDatabase(seed55); const target = await createDatabase(seed55);
    await withPool(source, async (pool) => {
      await pool.query('CREATE SEQUENCE recovery_test_sequence');
      await pool.query("SELECT setval('recovery_test_sequence', 17, true)");
      await pool.query(`CREATE FUNCTION recovery_failure_gate(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
        BEGIN IF current_database() = '${target}' THEN RAISE EXCEPTION 'controlled_post_data_failure'; END IF; RETURN value; END $$`);
      await pool.query('CREATE INDEX recovery_failure_index ON customers(recovery_failure_gate(name))');
    });
    const file = dump(source, 'late-failure');
    await withPool(target, async (pool) => {
      await pool.query('CREATE SEQUENCE recovery_test_sequence');
      await pool.query("SELECT setval('recovery_test_sequence', 91, true)");
      const before = await snapshot(pool); const result = recover(target, file, 'late-failure');
      expect(result.output).toContain('RECOVERY_PREFLIGHT_PASS');
      expect(result.status, result.output).toBe(5);
      expect(result.output).toContain('controlled_post_data_failure');
      expect(result.output).not.toContain('RECOVERY=PASS');
      expect(await snapshot(pool)).toEqual(before);
      expect(result.env).toContain('HEALTH_SCHEMA_VERSION=058_sale_integer_quantity');
    });
  });
  it.each(['interleave', 'equal', 'reverse'] as const)('R2 legacy recovery accepts exact 055 with %s timestamps/insertion order', async (mode) => {
    const source = await createDatabase(seed55); const target = await createDatabase(seed55);
    await withPool(source, async (pool) => {
      await pool.query('DELETE FROM schema_migrations');
      const versions = oldCatalog.entries.map((entry) => entry.version);
      if (mode === 'reverse') versions.reverse();
      for (const version of versions) await pool.query('INSERT INTO schema_migrations(version,applied_at) VALUES($1,$2)',
        [version, mode === 'interleave' && version.startsWith('050_') ? '2099-01-01' : '2020-01-01']);
      const file = dump(source, mode);
      const original = await snapshot(pool); const expected = await restoredSnapshot(file);
      expect(expected.rows).toEqual(original.rows);
      expect(expected.constraints.length).toBe(original.constraints.length);
      const result = recover(target, file, mode);
      expect(result.status, result.output).toBe(0);
      await withPool(target, async (targetPool) => { expect(await snapshot(targetPool)).toEqual(expected); });
    });
  });
  const invalidHistories = [
    ['missing-middle', "DELETE FROM schema_migrations WHERE version LIKE '030_%'"],
    ['branch', "UPDATE schema_migrations SET version='030_alternative_branch' WHERE version LIKE '030_%'"],
    ['future', "INSERT INTO schema_migrations(version) VALUES('999_future')"],
    ['duplicate-number', "INSERT INTO schema_migrations(version) VALUES('030_duplicate_number')"],
    ['duplicate-version', 'ALTER TABLE schema_migrations DROP CONSTRAINT schema_migrations_pkey; INSERT INTO schema_migrations(version) SELECT version FROM schema_migrations LIMIT 1'],
    ['invalid', "UPDATE schema_migrations SET version='invalid' WHERE version LIKE '030_%'"],
    ['empty', 'DELETE FROM schema_migrations'],
  ];
  it.each(invalidHistories)('R3 adapter rejects %s full-history corruption for both catalogs', async (_name, sql) => {
    for (const [seed, expectedCatalog] of [[seed55, oldCatalog], [seed56, catalog]] as const) {
      const target = await createDatabase(seed);
      await withPool(target, async (pool) => {
        await pool.query(sql!); const before = await snapshot(pool);
        const history = await new PostgresMigrationStore(pool).getAppliedVersions();
        expect(compareMigrationState(expectedCatalog, history).status).not.toBe('COMPATIBLE');
        await expect(validateRestoredDatabase(dbUrl(target), manifest(expectedCatalog.head!.version), expectedCatalog)).rejects.toThrow();
        expect(await snapshot(pool)).toEqual(before);
      });
    }
  });
  it('R3 rejects a malformed dump history before same-schema target mutation', async () => {
    const source = await createDatabase(seed55); const target = await createDatabase(seed55);
    await withPool(source, async (pool) => { await pool.query("DELETE FROM schema_migrations WHERE version LIKE '030_%'"); });
    await withPool(target, async (pool) => {
      const before = await snapshot(pool); const result = recover(target, dump(source, 'bad-history'), 'bad-history');
      expect(result.status).toBe(6); expect(result.output).toContain('RECOVERY_HISTORY_DIVERGED');
      expect(result.output).not.toContain('RESTORE=PASS'); expect(result.output).not.toContain('RECOVERY=PASS');
      expect(result.env).toContain('HEALTH_SCHEMA_VERSION=058_sale_integer_quantity');
      expect(await snapshot(pool)).toEqual(before);
    });
  });
  // A real dump, new database, restore and two catalog checks need the same
  // emulated-CI allowance as the same-schema restore above; assertions stay intact.
  it('R1/R3 new-target restore validates full history while the live database stays unchanged', async () => {
    const file = dump(seed55, 'new-target');
    const name = `servora_med_test_restore_${randomUUID().replaceAll('-', '')}`;
    await withPool(seed56, async (live) => {
      const before = await snapshot(live);
      const target = await restoreDumpIntoNewDatabase({ adminDatabaseUrl: url!, targetDatabase: name,
        dumpPath: file, sourceServerVersion: '17.11', productionDatabaseUrl: dbUrl(seed56) });
      try {
        expect(await validateRestoredDatabase(target.targetDatabaseUrl, manifest(oldCatalog.head!.version), oldCatalog))
          .toMatchObject({ schemaVersion: oldCatalog.head!.version });
        await expect(validateRestoredDatabase(target.targetDatabaseUrl, manifest(catalog.head!.version), catalog)).rejects.toThrow();
        expect(await snapshot(live)).toEqual(before);
      } finally { await dropRestoreTargetIfCreated(url!, name); }
    });
  }, 30_000);
  it('R3 accepts exact 055 and 056 catalogs instead of trusting a matching manifest head alone', async () => {
    for (const [seed, expectedCatalog] of [[seed55, oldCatalog], [seed56, catalog]] as const) {
      await withPool(seed, async (pool) => { await pool.query("UPDATE schema_migrations SET applied_at='2020-01-01'::timestamptz"); });
      expect(await validateRestoredDatabase(dbUrl(seed), manifest(expectedCatalog.head!.version), expectedCatalog))
        .toMatchObject({ schemaVersion: expectedCatalog.head!.version });
    }
  });
  it('R3 caller permits new-target READY_FOR_CUTOVER only after verified-release full-history validation', async () => {
    for (const [seed, expectedCatalog, sha] of [[seed55, oldCatalog, oldSha], [seed56, catalog, newSha]] as const) {
      const name = `servora_med_test_restore_${randomUUID().replaceAll('-', '')}`; created.push(name);
      const archive = packageFixture(seed, `service-${sha.slice(0, 2)}`, expectedCatalog.head!.version);
      const verified = await loadInstalledRecoveryCatalog(sha);
      expect(verified.catalog.entries.map((entry) => entry.version)).toEqual(expectedCatalog.entries.map((entry) => entry.version));
      await withPool(seed56, async (live) => {
        const before = await snapshot(live);
        const result = await new RestoreService({ releaseSha: sha, targetAdminDatabaseUrl: url!,
          productionDatabaseUrl: dbUrl(seed56), workspaceRoot: path.join(root, 'service-workspace') }).restore({
          archiveOrId: archive, mode: 'DISASTER_RECOVERY', targetDatabase: name, acknowledgeDestructiveRestore: true,
        });
        expect(result.outcome).toBe('READY_FOR_CUTOVER');
        expect(result.evidence.schemaVersion).toBe(expectedCatalog.head!.version);
        await withPool(name, async (restored) => {
          expect((await restored.query('SELECT status FROM restore_runs WHERE id=$1', [result.restoreRunId])).rows)
            .toEqual([{ status: 'READY_FOR_CUTOVER' }]);
        });
        expect(await snapshot(live)).toEqual(before);
      });
    }
  });
  it('R3 caller rejects missing-middle restore and never produces READY_FOR_CUTOVER', async () => {
    const source = await createDatabase(seed55);
    await withPool(source, async (pool) => { await pool.query("DELETE FROM schema_migrations WHERE version LIKE '030_%'"); });
    const archive = packageFixture(source, 'service-gap', oldCatalog.head!.version);
    const name = `servora_med_test_restore_${randomUUID().replaceAll('-', '')}`;
    await withPool(seed56, async (live) => {
      const before = await snapshot(live);
      await expect(new RestoreService({ releaseSha: oldSha, targetAdminDatabaseUrl: url!,
        productionDatabaseUrl: dbUrl(seed56), workspaceRoot: path.join(root, 'gap-workspace') }).restore({
        archiveOrId: archive, mode: 'DISASTER_RECOVERY', targetDatabase: name, acknowledgeDestructiveRestore: true,
      })).rejects.toMatchObject({ code: 'RESTORE_INTEGRITY_FAILED' });
      expect((await admin!.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rows).toEqual([]);
      expect(await snapshot(live)).toEqual(before);
    });
  });
  it('R3 caller refuses a 055 backup with a verified 056 release before target creation', async () => {
    const archive = packageFixture(seed55, 'service-cross', oldCatalog.head!.version);
    const name = `servora_med_test_restore_${randomUUID().replaceAll('-', '')}`;
    await expect(new RestoreService({ releaseSha: newSha, targetAdminDatabaseUrl: url!,
      workspaceRoot: path.join(root, 'cross-workspace') }).restore({
      archiveOrId: archive, mode: 'DISASTER_RECOVERY', targetDatabase: name, acknowledgeDestructiveRestore: true,
    })).rejects.toThrow('backup does not match');
    expect((await admin!.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rows).toEqual([]);
  });
});
