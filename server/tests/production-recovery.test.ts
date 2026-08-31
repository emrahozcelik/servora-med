import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const recoveryHelper = fileURLToPath(new URL('../../ops/scripts/production-recovery.sh', import.meta.url));
const hostHelper = fileURLToPath(new URL('../../ops/scripts/deploy-production-host.sh', import.meta.url));
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const TEST_SHA = 'a'.repeat(40);
const OLD_VERSION = '037_staff_offboarding_audit';
const NEW_VERSION = '041_user_lifecycle_reconciliation';

function temporaryDirectory(prefix: string) {
  return mkdtempSync(join(tmpdir(), `servora-recovery-${prefix}-`));
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function runRecovery(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [recoveryHelper, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function createBackupFixture(root: string, valid: boolean) {
  const backup = join(root, 'servora-med-20250831T120000Z.dump');
  const checksum = `${backup}.sha256`;
  const content = valid ? 'valid-dump-content' : 'invalid';
  writeFileSync(backup, content);
  const digest = sha256(content);
  const sidecarDigest = valid ? digest : 'b'.repeat(64);
  writeFileSync(checksum, `${sidecarDigest}  ${backup.split('/').pop()}\n`);
  return { backup, checksum, digest };
}

describe('production-recovery helper — syntax and contract', () => {
  it('remains syntactically valid', () => {
    execFileSync('bash', ['-n', recoveryHelper], { stdio: 'pipe' });
    execFileSync('bash', ['-n', hostHelper], { stdio: 'pipe' });
  });

  it('exposes fail-closed flags and loopback-only host check', () => {
    const content = readFileSync(recoveryHelper, 'utf8');
    expect(content).toContain('PRODUCTION_RECOVERY_REFUSED');
    expect(content).toContain('CHECKSUM_MISMATCH');
    expect(content).toContain('INVALID_TARGET_DB');
    expect(content).toContain('INVALID_EXPECTED_HOST');
    expect(content).toContain('--allow-destructive');
    expect(content).toContain('servora_med');
    expect(content).toContain('127.0.0.1');
    expect(content).not.toMatch(/pg_restore.*--clean.*--create/);
  });

  it('refuses without --allow-destructive', () => {
    const root = temporaryDirectory('no-destructive');
    try {
      const { backup, checksum } = createBackupFixture(root, true);
      const envFile = join(root, 'servora-med.env');
      writeFileSync(envFile, `HEALTH_SCHEMA_VERSION=${OLD_VERSION}\n`);
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--old-release',
          TEST_SHA,
          '--old-health-schema-version',
          OLD_VERSION,
          '--env-file',
          envFile,
        ],
        { TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med_recovery_test' },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('DESTRUCTIVE_NOT_AUTHORIZED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses checksum mismatch', () => {
    const root = temporaryDirectory('checksum-mismatch');
    try {
      const backup = join(root, 'servora-med-20250831T120000Z.dump');
      writeFileSync(backup, 'content-a');
      const badDigest = 'b'.repeat(64);
      const checksum = `${backup}.sha256`;
      writeFileSync(checksum, `${badDigest}  ${backup.split('/').pop()}\n`);
      const envFile = join(root, 'servora-med.env');
      writeFileSync(envFile, `HEALTH_SCHEMA_VERSION=${OLD_VERSION}\n`);
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          TEST_SHA,
          '--old-health-schema-version',
          OLD_VERSION,
          '--env-file',
          envFile,
        ],
        { TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med_recovery_test' },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('CHECKSUM_MISMATCH');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses wrong target DB', () => {
    const root = temporaryDirectory('wrong-db');
    try {
      const { backup, checksum } = createBackupFixture(root, true);
      const envFile = join(root, 'servora-med.env');
      writeFileSync(envFile, `HEALTH_SCHEMA_VERSION=${OLD_VERSION}\n`);
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'other_db',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          TEST_SHA,
          '--old-health-schema-version',
          OLD_VERSION,
          '--env-file',
          envFile,
        ],
        { TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med_recovery_test' },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('INVALID_TARGET_DB');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses wrong host (remote)', () => {
    const root = temporaryDirectory('wrong-host');
    try {
      const { backup, checksum } = createBackupFixture(root, true);
      const envFile = join(root, 'servora-med.env');
      writeFileSync(envFile, `HEALTH_SCHEMA_VERSION=${OLD_VERSION}\n`);
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '10.0.0.5',
          '--allow-destructive',
          '--old-release',
          TEST_SHA,
          '--old-health-schema-version',
          OLD_VERSION,
          '--env-file',
          envFile,
        ],
        { TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med_recovery_test' },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('INVALID_EXPECTED_HOST');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses invalid archive (pg_restore --list fails)', () => {
    const root = temporaryDirectory('invalid-archive');
    try {
      const backup = join(root, 'servora-med-20250831T120000Z.dump');
      writeFileSync(backup, 'not-a-valid-pg-dump');
      const digest = sha256('not-a-valid-pg-dump');
      const checksum = `${backup}.sha256`;
      writeFileSync(checksum, `${digest}  ${backup.split('/').pop()}\n`);
      const envFile = join(root, 'servora-med.env');
      writeFileSync(envFile, `HEALTH_SCHEMA_VERSION=${OLD_VERSION}\n`);
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'pg_restore'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      writeFileSync(join(bin, 'psql'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          TEST_SHA,
          '--old-health-schema-version',
          OLD_VERSION,
          '--env-file',
          envFile,
        ],
        {
          TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med_recovery_test',
          PG_RESTORE_BIN: join(bin, 'pg_restore'),
          PSQL_BIN: join(bin, 'psql'),
        },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('BACKUP_ARCHIVE_INVALID');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses missing backup', () => {
    const root = temporaryDirectory('missing-backup');
    try {
      const missing = join(root, 'servora-med-20250831T120000Z.dump');
      const checksum = `${missing}.sha256`;
      writeFileSync(checksum, `${'a'.repeat(64)}  ${missing.split('/').pop()}\n`);
      const envFile = join(root, 'servora-med.env');
      writeFileSync(envFile, `HEALTH_SCHEMA_VERSION=${OLD_VERSION}\n`);
      const result = runRecovery(
        [
          '--backup',
          missing,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          TEST_SHA,
          '--old-health-schema-version',
          OLD_VERSION,
          '--env-file',
          envFile,
        ],
        { TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med_recovery_test' },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('BACKUP_MISSING');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never logs DATABASE_URL secret', () => {
    const root = temporaryDirectory('secret');
    try {
      const { backup, checksum } = createBackupFixture(root, true);
      const envFile = join(root, 'servora-med.env');
      writeFileSync(envFile, `HEALTH_SCHEMA_VERSION=${OLD_VERSION}\n`);
      const secretUrl = 'postgresql://servora:s3cr3tP@ss@localhost:5432/servora_med_recovery_test';
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'pg_restore'), '#!/bin/sh\nif [ "$1" = "-l" ]; then echo "Dumped by pg_dump version: 16"; exit 0; fi\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(bin, 'psql'), '#!/bin/sh\nif echo "$*" | grep -q "schema_migrations"; then echo "037_staff_offboarding_audit"; exit 0; fi\nexit 0\n', { mode: 0o755 });
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          TEST_SHA,
          '--old-health-schema-version',
          OLD_VERSION,
          '--env-file',
          envFile,
        ],
        {
          TEST_DATABASE_URL: secretUrl,
          PG_RESTORE_BIN: join(bin, 'pg_restore'),
          PSQL_BIN: join(bin, 'psql'),
        },
      );
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).not.toContain('s3cr3tP@ss');
      expect(combined).not.toContain('postgresql://servora');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses TEST_DATABASE_URL pointing to protected servora_med', () => {
    const root = temporaryDirectory('protected');
    try {
      const { backup, checksum } = createBackupFixture(root, true);
      const envFile = join(root, 'servora-med.env');
      writeFileSync(envFile, `HEALTH_SCHEMA_VERSION=${OLD_VERSION}\n`);
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          TEST_SHA,
          '--old-health-schema-version',
          OLD_VERSION,
          '--env-file',
          envFile,
        ],
        { TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med' },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('TEST_DATABASE_URL_PRODUCTION_COLLISION');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('production-recovery — disposable DB integration', () => {
  const databaseUrl = process.env.TEST_DATABASE_URL as string;

  // Guard: never touch protected servora_med
  function assertNotProtected(url: string) {
    const parsed = new URL(url);
    const dbName = parsed.pathname.replace(/^\//, '').split('/')[0]?.split('?')[0] ?? '';
    if (dbName === 'servora_med') throw new Error('REFUSING protected servora_med');
  }

  it('does not mutate protected servora_med via helper (guard)', () => {
    assertNotProtected(databaseUrl);
    expect(databaseUrl).not.toMatch(/\/servora_med(\?|$)/);
  });

  it('performs mocked restore with env atomic, mode 640, no duplicate, secret-safe', async () => {
    // This test uses mocked pg_restore/psql, not real DB, but runs under TEST_DATABASE_URL guard
    // to prove the helper works in test mode without touching production.
    const root = temporaryDirectory('mocked-restore-env');
    try {
      const backup = join(root, 'servora-med-20250831T120000Z.dump');
      writeFileSync(backup, 'dump-content');
      const digest = sha256('dump-content');
      const checksum = `${backup}.sha256`;
      writeFileSync(checksum, `${digest}  ${backup.split('/').pop()}\n`);
      const envFile = join(root, 'servora-med.env');
      // Env has new version, then recovery should roll back to old atomically
      writeFileSync(envFile, `DATABASE_URL=postgresql://user:keep@localhost/db\nHEALTH_SCHEMA_VERSION=${NEW_VERSION}\nOTHER=keep\n`);
      const bin = join(root, 'bin');
      mkdirSync(bin);
      // Mock pg_restore -l success and pg_restore restore success
      writeFileSync(
        join(bin, 'pg_restore'),
        '#!/bin/sh\nif [ "$1" = "-l" ]; then echo "Dumped by pg_dump version: 16"; exit 0; fi\nexit 0\n',
        { mode: 0o755 },
      );
      // Mock psql to return OLD_VERSION as head and accept other queries
      writeFileSync(
        join(bin, 'psql'),
        `#!/bin/sh
if echo "$*" | grep -q "COUNT"; then echo "41"; exit 0; fi
if echo "$*" | grep -q "schema_migrations"; then echo "${OLD_VERSION}"; exit 0; fi
if echo "$*" | grep -q "users"; then exit 0; fi
if echo "$*" | grep -q "job_cards"; then exit 0; fi
exit 0
`,
        { mode: 0o755 },
      );
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          TEST_SHA,
          '--old-health-schema-version',
          OLD_VERSION,
          '--env-file',
          envFile,
        ],
        {
          TEST_DATABASE_URL: databaseUrl,
          PG_RESTORE_BIN: join(bin, 'pg_restore'),
          PSQL_BIN: join(bin, 'psql'),
        },
      );
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('RECOVERY=PASS');
      expect(`${result.stdout}${result.stderr}`).toContain(`head=${OLD_VERSION}`);
      const after = readFileSync(envFile, 'utf8');
      expect(after).toContain(`HEALTH_SCHEMA_VERSION=${OLD_VERSION}`);
      expect(after).not.toContain(NEW_VERSION);
      expect(after).toContain('OTHER=keep');
      expect(after).toContain('DATABASE_URL=postgresql://user:keep@localhost/db');
      expect((after.match(/^HEALTH_SCHEMA_VERSION=/gm) || []).length).toBe(1);
      // Secret not logged
      expect(`${result.stdout}${result.stderr}`).not.toContain('keep');
      // Verify file mode is 640 or 600 (mocked chown not required)
      const mode = (await import('node:fs')).statSync(envFile).mode & 0o777;
      expect([0o640, 0o600]).toContain(mode);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores real disposable DB via pg_dump/pg_restore when tools available', async () => {
    // Full integration with real postgres — skipped if pg_dump not available or no CREATEDB privilege
    const hasPgDump = spawnSync('which', ['pg_dump'], { encoding: 'utf8' }).status === 0;
    const hasPgRestore = spawnSync('which', ['pg_restore'], { encoding: 'utf8' }).status === 0;
    if (!hasPgDump || !hasPgRestore) {
      console.warn('Skipping real DB restore: pg_dump/pg_restore not available');
      return;
    }
    assertNotProtected(databaseUrl);
    const admin = new Pool({ connectionString: databaseUrl });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const srcDb = `servora_med_recovery_src_${suffix}`;
    const targetDb = `servora_med_recovery_target_${suffix}`;
    const root = temporaryDirectory(`real-restore-${suffix}`);
    let srcPool: Pool | null = null;
    let targetPool: Pool | null = null;
    try {
      // Create src DB at OLD_VERSION (037) and target at 038 to simulate partial
      await admin.query(`CREATE DATABASE ${srcDb}`);
      await admin.query(`CREATE DATABASE ${targetDb}`);
      const srcUrl = new URL(databaseUrl);
      srcUrl.pathname = `/${srcDb}`;
      const targetUrl = new URL(databaseUrl);
      targetUrl.pathname = `/${targetDb}`;
      srcPool = new Pool({ connectionString: srcUrl.toString() });
      targetPool = new Pool({ connectionString: targetUrl.toString() });
      // Load migrations up to 037 for src, up to 038 for target
      // For simplicity, run all migrations then delete 038+ for src? Instead, use catalog filtering.
      // We will use a temp migrations dir containing only up to 037 for src.
      const { mkdtemp, readdir, readFile, writeFile, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join: pathJoin } = await import('node:path');
      const { loadMigrationCatalog } = await import('../src/db/migration-catalog.js');
      const { PostgresMigrationStore } = await import('../src/db/index.js');
      const { runMigrations } = await import('../src/db/migrate-runner.js');
      const catalog = await loadMigrationCatalog(migrationsDirectory);
      // Create temp dir for 037
      const tmp037 = await mkdtemp(pathJoin(tmpdir(), 'migrations-037-'));
      const tmp038 = await mkdtemp(pathJoin(tmpdir(), 'migrations-038-'));
      try {
        for (const e of catalog.entries.filter((x) => x.number <= 37)) {
          const sql = await readFile(pathJoin(migrationsDirectory, e.filename), 'utf8');
          await writeFile(pathJoin(tmp037, e.filename), sql, 'utf8');
        }
        for (const e of catalog.entries.filter((x) => x.number <= 38)) {
          const sql = await readFile(pathJoin(migrationsDirectory, e.filename), 'utf8');
          await writeFile(pathJoin(tmp038, e.filename), sql, 'utf8');
        }
        await runMigrations({ migrationsDirectory: tmp037, store: new PostgresMigrationStore(srcPool) });
        await runMigrations({ migrationsDirectory: tmp038, store: new PostgresMigrationStore(targetPool) });
      } finally {
        await rm(tmp037, { recursive: true, force: true });
        await rm(tmp038, { recursive: true, force: true });
      }
      // Verify heads
      const srcHead = await srcPool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1');
      const targetHeadBefore = await targetPool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1');
      expect(srcHead.rows[0]?.version).toBe(OLD_VERSION);
      expect(targetHeadBefore.rows[0]?.version).toBe('038_demo_dataset_audit_types');
      // Dump src DB
      const backup = join(root, 'servora-med-20250831T120000Z.dump');
      const parsed = new URL(databaseUrl);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PGHOST: parsed.hostname,
        PGPORT: parsed.port || '5432',
        PGUSER: decodeURIComponent(parsed.username),
        PGDATABASE: srcDb,
      };
      if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
      execFileSync('pg_dump', ['-Fc', '--no-owner', '--no-acl', '--file', backup], { env });
      expect(existsSync(backup)).toBe(true);
      const backupData = readFileSync(backup);
      const digest = sha256(backupData.toString());
      // For binary, we need sha256 of file bytes
      const actualDigest = createHash('sha256').update(backupData).digest('hex');
      const checksum = `${backup}.sha256`;
      writeFileSync(checksum, `${actualDigest}  ${backup.split('/').pop()}\n`);
      // Prepare env file with NEW_VERSION (to be rolled back)
      const envFile = join(root, 'servora-med.env');
      writeFileSync(envFile, `HEALTH_SCHEMA_VERSION=${NEW_VERSION}\nOTHER=keep\n`);
      // Run recovery against target DB via TEST_DATABASE_URL
      const targetUrlString = targetUrl.toString();
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          TEST_SHA,
          '--old-health-schema-version',
          OLD_VERSION,
          '--env-file',
          envFile,
        ],
        { TEST_DATABASE_URL: targetUrlString },
      );
      // Recovery should succeed
      if (result.status !== 0) {
        console.warn('Recovery failed, output:', `${result.stdout}${result.stderr}`);
      }
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('RECOVERY=PASS');
      const afterEnv = readFileSync(envFile, 'utf8');
      expect(afterEnv).toContain(`HEALTH_SCHEMA_VERSION=${OLD_VERSION}`);
      expect((afterEnv.match(/^HEALTH_SCHEMA_VERSION=/gm) || []).length).toBe(1);
      // Verify DB head is now OLD_VERSION
      const targetHeadAfter = await targetPool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1');
      expect(targetHeadAfter.rows[0]?.version).toBe(OLD_VERSION);
    } catch (e) {
      // If we lack CREATEDB privilege, skip gracefully
      const msg = String((e as Error).message);
      if (msg.includes('permission denied') || msg.includes('must be superuser') || msg.includes('CREATE DATABASE')) {
        console.warn('Skipping real DB test due to lack of privilege:', msg);
        return;
      }
      throw e;
    } finally {
      if (srcPool) await srcPool.end().catch(() => {});
      if (targetPool) await targetPool.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${srcDb}`).catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${targetDb}`).catch(() => {});
      await admin.end().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
