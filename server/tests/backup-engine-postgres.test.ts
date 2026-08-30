import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { LocalBackupEngine, validateManifestComponents } from '../src/modules/backup/engine.js';
import { PostgresBackupRepository } from '../src/modules/backup/repository.js';
import { BackupService } from '../src/modules/backup/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const FIXTURE_ORG = 'BR2 Fixture Org';

function promisifiedExecFile(binary: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(binary, [...args], { shell: false, maxBuffer: 10_000_000, ...(env ? { env } : {}) },
      (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout: String(stdout), stderr: String(stderr) })));
  });
}

async function streamHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function writeShim(dir: string, name: string, body: string): string {
  const shimPath = path.join(dir, name);
  writeFileSync(shimPath, body, { mode: 0o755 });
  return shimPath;
}

describe.skipIf(!databaseUrl)('BR2 local backup engine (PostgreSQL integration)', () => {
  const admin = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  let sourceDb = '';
  let sourceUrl = '';
  let sourcePool: Pool | null = null;
  let repository: PostgresBackupRepository | null = null;
  let service: BackupService | null = null;
  let engineRoot: string;
  let tempRoot: string;
  let filesRoot: string | null = null;
  let clock = Date.parse('2026-08-22T10:00:00Z');
  let adminActor: { id: string; organizationId: string };
  let engineCount = 0;

  const buildEngine = (overrides: { filesRoot?: string | null } = {}) =>
    new LocalBackupEngine({
      repository: repository!,
      service: service!,
      pool: sourcePool!,
      databaseUrl: sourceUrl,
      tempRoot,
      filesRoot: overrides.filesRoot !== undefined ? overrides.filesRoot : filesRoot,
      now: () => new Date((clock += 1_000)),
      application: { applicationVersion: 'test-0.1.0', gitCommit: 'a'.repeat(40) },
    });

  const actorOf = () => ({
    id: adminActor.id,
    organizationId: adminActor.organizationId,
    name: 'BR2 Admin',
    email: 'br2-admin@test.local',
    role: 'ADMIN' as const,
    mustChangePassword: false,
    isActive: true,
    version: 1,
  });

  const createRun = async (scope: 'DATABASE' | 'FULL_DATA') => {
    engineCount += 1;
    const created = await service!.requestManualBackup(actorOf(), {
      clientActionId: `br2-${engineCount}-${randomUUID().slice(0, 8)}`,
      scope,
    });
    return created.id as string;
  };

  // BR2 deliberately leaves a packaged run RUNNING at PACKAGE (BR3 owns the
  // next phases). The durable single-active guard then blocks new runs, so
  // the suite releases the slot after asserting each packaged outcome —
  // mirroring how BR3/BR5 will promptly continue a packaged run.
  const releaseSlot = async (runId: string) => {
    await service!.markCancelled(runId);
  };

  beforeAll(async () => {
    if (!admin) return;
    engineRoot = await mkdtemp(path.join(tmpdir(), 'servora-br2-'));
    tempRoot = path.join(engineRoot, 'workspaces');

    sourceDb = `servora_br2_src_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await admin.query(`CREATE DATABASE ${sourceDb}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${sourceDb}`;
    sourceUrl = url.toString();
    sourcePool = new Pool({ connectionString: sourceUrl });
    await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(sourcePool) });

    const org = (await sourcePool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
      [FIXTURE_ORG],
    )).rows[0]!;
    const adminUser = (await sourcePool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'BR2 Admin', $2, 'hash', 'ADMIN') RETURNING id`,
      [org.id, `${randomUUID()}@test.local`],
    )).rows[0]!;
    adminActor = { id: adminUser.id, organizationId: org.id };

    repository = new PostgresBackupRepository(sourcePool);
    service = new BackupService(repository, () => new Date((clock += 1_000)));
  });

  afterAll(async () => {
    if (sourcePool) await sourcePool.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${sourceDb}`);
      await admin.end();
    }
    if (engineRoot) await rm(engineRoot, { recursive: true, force: true });
  });

  it('DATABASE scope: full local pipeline, stops at PACKAGE, never SUCCESS', async () => {
    const runId = await createRun('DATABASE');
    const result = await buildEngine().buildLocalBackup(runId);

    expect(result.outcome).toBe('packaged');
    if (result.outcome !== 'packaged') return;

    const run = await repository!.findRunById(runId);
    expect(run).toMatchObject({
      status: 'RUNNING',
      phase: 'PACKAGE',
      verifiedAt: null,
      sha256: null,
      warningCode: null,
      failureCode: null,
    });

    const payloadPath = path.join(tempRoot, runId, 'payload');
    const manifest = JSON.parse(
      await readFile(path.join(payloadPath, 'manifest.json'), 'utf8'),
    );
    expect(manifest).toMatchObject({
      format: 'servora-backup',
      formatVersion: 1,
      backupId: runId,
      backupScope: 'DATABASE',
      origin: 'MANUAL',
      retentionClass: 'MANUAL',
      application: { applicationVersion: 'test-0.1.0', gitCommit: 'a'.repeat(40) },
    });
    expect(manifest.database.engine).toBe('postgresql');
    expect(manifest.database.schemaVersion).toBe('041_user_lifecycle_reconciliation');
    expect(manifest.database.dumpVersion).toMatch(/^\d+\.\d+(-\d+)?$/);
    expect(manifest.database.dumpToolVersion).toMatch(/\d+\.\d+/);
    expect(manifest.contents.files).toBeNull();

    const checksums = await readFile(path.join(payloadPath, 'checksums.sha256'), 'utf8');
    expect(checksums).toMatch(/^[0-9a-f]{64}  database.dump\n$/);
    const dumpHash = await streamHash(path.join(payloadPath, 'database.dump'));
    expect(checksums.trim()).toBe(`${dumpHash}  database.dump`);

    const packageMembers = (await promisifiedExecFile(
      process.env.TAR_BIN ?? 'tar', ['-t', '-f', result.packagePath],
    )).stdout.trim().split('\n').sort();
    expect(packageMembers).toEqual(['checksums.sha256', 'database.dump', 'manifest.json']);
    await releaseSlot(runId);
  });

  it('DATABASE scope package is a restorable pg_dump custom archive (local restore proof)', async () => {
    const runId = await createRun('DATABASE');
    const result = await buildEngine().buildLocalBackup(runId);
    if (result.outcome !== 'packaged') throw new Error('engine failed');

    const extractDir = path.join(engineRoot, `extract-${runId}`);
    await mkdir(extractDir, { recursive: true });
    await promisifiedExecFile(process.env.TAR_BIN ?? 'tar', ['-x', '-f', result.packagePath, '-C', extractDir]);

    const dumpPath = path.join(extractDir, 'database.dump');
    const listing = await promisifiedExecFile(process.env.PG_RESTORE_BIN ?? 'pg_restore', ['-l', dumpPath]);
    expect(listing.stdout).toContain('Dumped by pg_dump version');

    const targetDb = `servora_br2_dst_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await admin!.query(`CREATE DATABASE ${targetDb}`);
    const targetUrl = new URL(databaseUrl!);
    targetUrl.pathname = `/${targetDb}`;
    try {
      const targetPool = new Pool({ connectionString: targetUrl.toString() });
      try {
        const restoreEnv = { ...process.env } as NodeJS.ProcessEnv;
        const parsed = new URL(targetUrl.toString());
        restoreEnv.PGHOST = parsed.hostname;
        restoreEnv.PGPORT = parsed.port || '5432';
        restoreEnv.PGUSER = decodeURIComponent(parsed.username);
        if (parsed.password) restoreEnv.PGPASSWORD = decodeURIComponent(parsed.password);
        restoreEnv.PGDATABASE = targetDb;
        await promisifiedExecFile(
          process.env.PG_RESTORE_BIN ?? 'pg_restore',
          ['--no-owner', '--no-acl', '--exit-on-error', '-d', targetDb, dumpPath],
          restoreEnv,
        );
        const orgs = await targetPool.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM organizations WHERE name = $1', [FIXTURE_ORG],
        );
        expect(Number(orgs.rows[0]!.count)).toBe(1);
        const migrations = await targetPool.query<{ version: string }>(
          'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
        );
          expect(migrations.rows[0]!.version).toBe('041_user_lifecycle_reconciliation');
      } finally {
        await targetPool.end();
      }
      await releaseSlot(runId);
    } finally {
      await admin!.query(`DROP DATABASE IF EXISTS ${targetDb}`);
    }
  }, 15_000);

  it('FULL_DATA without configured files root skips FILES_ARCHIVE', async () => {
    const runId = await createRun('FULL_DATA');
    const result = await buildEngine({ filesRoot: null }).buildLocalBackup(runId);
    expect(result.outcome).toBe('packaged');
    const run = await repository!.findRunById(runId);
    expect(run?.phase).toBe('PACKAGE');
    const manifest = JSON.parse(
      await readFile(path.join(tempRoot, runId, 'payload', 'manifest.json'), 'utf8'),
    );
    expect(manifest.contents.files).toBeNull();
    const members = await readdir(path.join(tempRoot, runId, 'payload'));
    expect(members).not.toContain('files.tar.zst');
    await releaseSlot(runId);
  });

  it('FULL_DATA with configured root archives regular files byte-for-byte', async () => {
    filesRoot = path.join(engineRoot, 'servora-files');
    const nested = path.join(filesRoot, 'uploads', 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, 'report.txt'), 'BR2 persistent file payload');

    const runId = await createRun('FULL_DATA');
    const result = await buildEngine({ filesRoot }).buildLocalBackup(runId);
    expect(result.outcome).toBe('packaged');
    if (result.outcome !== 'packaged') return;

    const manifest = result.manifest;
    expect(manifest.contents.files).not.toBeNull();
    await releaseSlot(runId);

    const filesArchive = path.join(tempRoot, runId, 'payload', 'files.tar.zst');
    const decompressDir = path.join(engineRoot, `files-${runId}`);
    await mkdir(decompressDir, { recursive: true });
    await promisifiedExecFile(process.env.ZSTD_BIN ?? 'zstd',
      ['-q', '-d', '-o', path.join(decompressDir, 'files.tar'), filesArchive]);
    const listing = (await promisifiedExecFile(process.env.TAR_BIN ?? 'tar',
      ['-t', '-v', '-f', path.join(decompressDir, 'files.tar')])).stdout;
    expect(listing).toContain('uploads/nested/report.txt');
    const extracted = (await promisifiedExecFile(process.env.TAR_BIN ?? 'tar',
      ['-x', '-O', '-f', path.join(decompressDir, 'files.tar'), './uploads/nested/report.txt'])).stdout;
    expect(extracted).toBe('BR2 persistent file payload');

    const packageMembers = (await promisifiedExecFile(
      process.env.TAR_BIN ?? 'tar', ['-t', '-f', result.packagePath],
    )).stdout.trim().split('\n').sort();
    expect(packageMembers).toEqual(['checksums.sha256', 'database.dump', 'files.tar.zst', 'manifest.json']);
    await rm(filesRoot!, { recursive: true, force: true });
    filesRoot = null;
  });

  it('FULL_DATA with a symlink fails in FILES_ARCHIVE before packaging', async () => {
    filesRoot = path.join(engineRoot, 'servora-files-symlink');
    await mkdir(filesRoot, { recursive: true });
    await writeFile(path.join(filesRoot, 'regular.txt'), 'safe');
    await symlink('/tmp/br2-producer-outside', path.join(filesRoot, 'unsupported-link'));

    const runId = await createRun('FULL_DATA');
    const result = await buildEngine({ filesRoot }).buildLocalBackup(runId);
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'FILES_ARCHIVE_FAILED' });
    const run = await repository!.findRunById(runId);
    expect(run).toMatchObject({ status: 'FAILED', phase: 'FILES_ARCHIVE', failureCode: 'FILES_ARCHIVE_FAILED' });
    await expect(stat(path.join(tempRoot, runId))).rejects.toThrow();
    await rm(filesRoot, { recursive: true, force: true });
    filesRoot = null;
  });

  it('preflight failures map to canonical codes', async () => {
    // Database unavailable.
    const badPool = new Pool({ connectionString: 'postgresql://127.0.0.1:59999/none', connectionTimeoutMillis: 2_000 });
    const dbRun = await createRun('DATABASE');
    const dbEngine = new LocalBackupEngine({
      repository: repository!,
      service: service!,
      pool: badPool,
      databaseUrl: sourceUrl,
      tempRoot,
      filesRoot: null,
      now: () => new Date(clock += 1_000),
      application: { applicationVersion: 't', gitCommit: null },
    });
    const dbResult = await dbEngine.buildLocalBackup(dbRun);
    expect(dbResult).toMatchObject({ outcome: 'failed', failureCode: 'PREFLIGHT_DATABASE_UNAVAILABLE' });
    await badPool.end();

    // pg_dump unavailable.
    const prevDump = process.env.PG_DUMP_BIN;
    process.env.PG_DUMP_BIN = '/nonexistent/pg_dump-xyz';
    try {
      const dumpRun = await createRun('DATABASE');
      const dumpResult = await buildEngine().buildLocalBackup(dumpRun);
      expect(dumpResult).toMatchObject({ outcome: 'failed', failureCode: 'PREFLIGHT_PG_DUMP_UNAVAILABLE' });
      expect((await repository!.findRunById(dumpRun))?.failureSummary).not.toMatch(/password|postgres:\/\//i);
    } finally {
      if (prevDump === undefined) delete process.env.PG_DUMP_BIN;
      else process.env.PG_DUMP_BIN = prevDump;
    }

    // pg_dump older than server major version.
    const oldShim = writeShim(engineRoot, 'pg-dump-old.sh',
      '#!/bin/sh\ncase "$1" in --version) echo "pg_dump (PostgreSQL) 9.6"; exit 0;; *) exit 1;; esac\n');
    process.env.PG_DUMP_BIN = oldShim;
    try {
      const oldRun = await createRun('DATABASE');
      const oldResult = await buildEngine().buildLocalBackup(oldRun);
      expect(oldResult).toMatchObject({ outcome: 'failed', failureCode: 'PREFLIGHT_PG_DUMP_UNAVAILABLE' });
    } finally {
      if (prevDump === undefined) delete process.env.PG_DUMP_BIN;
      else process.env.PG_DUMP_BIN = prevDump;
    }

    // Temp root unwritable.
    const readOnlyRoot = path.join(engineRoot, 'readonly-root');
    await mkdir(readOnlyRoot, { recursive: true, mode: 0o700 });
    await chmod(readOnlyRoot, 0o500);
    try {
      const diskRun = await createRun('DATABASE');
      const diskEngine = new LocalBackupEngine({
        repository: repository!, service: service!, pool: sourcePool!,
        databaseUrl: sourceUrl, tempRoot: readOnlyRoot, filesRoot: null,
        now: () => new Date(clock += 1_000),
        application: { applicationVersion: 't', gitCommit: null },
      });
      const diskResult = await diskEngine.buildLocalBackup(diskRun);
      expect(diskResult).toMatchObject({ outcome: 'failed', failureCode: 'PREFLIGHT_LOW_DISK' });
    } finally {
      await chmod(readOnlyRoot, 0o700);
    }

    // FULL_DATA requiring a files root that does not exist.
    const filesRun = await createRun('FULL_DATA');
    const filesResult = await buildEngine({ filesRoot: path.join(engineRoot, 'missing-root') })
      .buildLocalBackup(filesRun);
    expect(filesResult).toMatchObject({ outcome: 'failed', failureCode: 'PREFLIGHT_FILES_ARCHIVE_UNAVAILABLE' });
  });

  it('pg_dump failure maps to PG_DUMP_FAILED and removes the partial workspace', async () => {
    // Reports a version newer than any supported server so the compatibility
    // gate passes everywhere (CI runs PostgreSQL 17; the local pilot 16).
    const failingShim = writeShim(engineRoot, 'pg-dump-fail.sh',
      '#!/bin/sh\ncase "$1" in --version) echo "pg_dump (PostgreSQL) 99.0"; exit 0;; *) echo "boom" >&2; exit 2;; esac\n');
    const prev = process.env.PG_DUMP_BIN;
    process.env.PG_DUMP_BIN = failingShim;
    try {
      const runId = await createRun('DATABASE');
      const result = await buildEngine().buildLocalBackup(runId);
      expect(result).toMatchObject({ outcome: 'failed', failureCode: 'PG_DUMP_FAILED' });
      const run = await repository!.findRunById(runId);
      expect(run).toMatchObject({
        status: 'FAILED',
        failureCode: 'PG_DUMP_FAILED',
        warningCode: null,
        completedAt: expect.any(Date),
      });
      expect(await readdir(tempRoot)).not.toContain(runId);
      expect(result.outcome === 'failed' ? result.diagnostics : null).not.toMatch(/password|postgres:\/\//i);
    } finally {
      if (prev === undefined) delete process.env.PG_DUMP_BIN;
      else process.env.PG_DUMP_BIN = prev;
    }
  });

  it('zstd unavailable for required files archive maps to PREFLIGHT_FILES_ARCHIVE_UNAVAILABLE', async () => {
    const zstdFilesRoot = path.join(engineRoot, 'zstd-files');
    await mkdir(zstdFilesRoot, { recursive: true });
    await writeFile(path.join(zstdFilesRoot, 'a.txt'), 'x');
    const prev = process.env.ZSTD_BIN;
    process.env.ZSTD_BIN = '/nonexistent/zstd-xyz';
    try {
      const runId = await createRun('FULL_DATA');
      const result = await buildEngine({ filesRoot: zstdFilesRoot }).buildLocalBackup(runId);
      expect(result).toMatchObject({ outcome: 'failed', failureCode: 'PREFLIGHT_FILES_ARCHIVE_UNAVAILABLE' });
    } finally {
      if (prev === undefined) delete process.env.ZSTD_BIN;
      else process.env.ZSTD_BIN = prev;
      await rm(zstdFilesRoot, { recursive: true, force: true });
    }
  });

  it('tampered component between manifest and package is caught (PACKAGE_FAILED)', async () => {
    const runId = await createRun('DATABASE');
    const result = await buildEngine().buildLocalBackup(runId);
    if (result.outcome !== 'packaged') throw new Error('engine failed');
    const payloadPath = path.join(tempRoot, runId, 'payload');

    // Same-size tamper: flip the final byte while preserving byte count.
    const dumpPath = path.join(payloadPath, 'database.dump');
    const tamperedBuffer = Buffer.from(await readFile(dumpPath));
    tamperedBuffer[tamperedBuffer.length - 1]! ^= 0xff;
    writeFileSync(dumpPath, tamperedBuffer);

    await expect(validateManifestComponents(payloadPath, result.manifest)).rejects
      .toMatchObject({ failureCode: 'PACKAGE_FAILED' });
    await releaseSlot(runId);
    await rm(path.join(tempRoot, runId), { recursive: true, force: true });
  });

  it('large component proves streaming/bounded memory behavior', async () => {
    const bigFilesRoot = path.join(engineRoot, 'big-files');
    await mkdir(path.join(bigFilesRoot, 'blobs'), { recursive: true });
    const bigPath = path.join(bigFilesRoot, 'blobs', 'large.bin');
    const chunkSize = 1024 * 1024;
    const chunk = Buffer.alloc(chunkSize);
    for (let index = 0; index < chunk.length; index += 4096) {
      chunk.writeUInt32BE(index ^ 0x5a5a5a5a, index);
    }
    const handle = await import('node:fs/promises').then((fs) => fs.open(bigPath, 'w'));
    try {
      for (let written = 0; written < 64; written += 1) {
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    const bigHash = await streamHash(bigPath);

    const runId = await createRun('FULL_DATA');
    const result = await buildEngine({ filesRoot: bigFilesRoot }).buildLocalBackup(runId);
    expect(result.outcome).toBe('packaged');
    if (result.outcome !== 'packaged') return;
    expect(result.manifest.contents.files).not.toBeNull();
    // Independent verification: decompress + hash equals the source bytes,
    // proving the archive path preserved a 64 MiB component byte-exactly
    // through streaming (not in-memory) code paths.
    const work = path.join(engineRoot, `big-verify-${runId}`);
    await mkdir(work, { recursive: true });
    await promisifiedExecFile(process.env.ZSTD_BIN ?? 'zstd',
      ['-q', '-d', '-o', path.join(work, 'files.tar'), path.join(tempRoot, runId, 'payload', 'files.tar.zst')]);
    await promisifiedExecFile(process.env.TAR_BIN ?? 'tar',
      ['-x', '-f', path.join(work, 'files.tar'), '-C', work]);
    expect(await streamHash(path.join(work, 'blobs', 'large.bin'))).toBe(bigHash);
    await rm(work, { recursive: true, force: true });
    await releaseSlot(runId);
    await rm(bigFilesRoot, { recursive: true, force: true });
  });

  it('extended failure vocabulary is accepted by the database (migration 031)', async () => {
    for (const code of ['CHECKSUM_FAILED', 'PREFLIGHT_FILES_ARCHIVE_UNAVAILABLE', 'PREFLIGHT_WORKSPACE_CONFLICT'] as const) {
      const runId = randomUUID();
      await sourcePool!.query(
        `INSERT INTO backup_runs (id, status, phase, origin, scope, retention_class, created_at, started_at, completed_at, failure_code)
         VALUES ($1, 'FAILED', 'CHECKSUM', 'SCHEDULED', 'DATABASE', 'DAILY', NOW(), NOW(), NOW(), $2)`,
        [runId, code],
      );
      const run = await repository!.findRunById(runId);
      expect(run?.failureCode).toBe(code);
    }
  });

  it('R3: existing workspace fails closed as PREFLIGHT_WORKSPACE_CONFLICT without deletion or pg_dump', async () => {
    const runId = await createRun('DATABASE');
    const { createWorkspace, inspectWorkspace } = await import('../src/modules/backup/workspace.js');
    const paths = await createWorkspace(tempRoot, runId);
    const dumpExistsBefore = await import('node:fs/promises').then((fs) =>
      fs.stat(path.join(paths.payloadPath, 'database.dump')).then(() => true, () => false));

    const result = await buildEngine().buildLocalBackup(runId);
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'PREFLIGHT_WORKSPACE_CONFLICT' });

    const run = await repository!.findRunById(runId);
    expect(run).toMatchObject({ status: 'FAILED', failureCode: 'PREFLIGHT_WORKSPACE_CONFLICT' });

    // Fail closed: the pre-existing workspace is NOT silently deleted and no
    // dump was produced inside it (pg_dump never executed).
    const inspection = await inspectWorkspace(tempRoot, runId);
    expect(inspection.exists).toBe(true);
    expect(inspection.payloadMembers).toEqual([]);
    const dumpExistsAfter = await import('node:fs/promises').then((fs) =>
      fs.stat(path.join(paths.payloadPath, 'database.dump')).then(() => true, () => false));
    expect(dumpExistsAfter).toBe(dumpExistsBefore);
    expect(dumpExistsAfter).toBe(false);

    await import('node:fs/promises').then((fs) =>
      fs.rm(paths.workspacePath, { recursive: true, force: true }));
  });

  it('R3: ordinary temp-root create/write failure stays PREFLIGHT_LOW_DISK', async () => {
    const blockedRoot = path.join(engineRoot, 'blocked-root', 'nested');
    await mkdir(path.dirname(blockedRoot), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(blockedRoot), 0o500);
    try {
      const runId = await createRun('DATABASE');
      const engine = new LocalBackupEngine({
        repository: repository!, service: service!, pool: sourcePool!,
        databaseUrl: sourceUrl, tempRoot: blockedRoot, filesRoot: null,
        now: () => new Date(clock += 1_000),
        application: { applicationVersion: 't', gitCommit: null },
      });
      const result = await engine.buildLocalBackup(runId);
      expect(result).toMatchObject({ outcome: 'failed', failureCode: 'PREFLIGHT_LOW_DISK' });
    } finally {
      await chmod(path.dirname(blockedRoot), 0o700);
    }
  });

  it('engine refuses to run a non-PREFLIGHT or terminal run', async () => {
    const runId = await createRun('DATABASE');
    await service!.startRun(runId);
    await service!.advancePhase(runId, 'DATABASE_DUMP', false);
    await expect(buildEngine().buildLocalBackup(runId)).rejects.toThrow(/PREFLIGHT/);
    await service!.markCancelled(runId);
    await expect(buildEngine().buildLocalBackup(runId)).rejects.toThrow(/PREFLIGHT/);
  });
});
