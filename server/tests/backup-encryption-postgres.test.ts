import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { LocalBackupEngine } from '../src/modules/backup/engine.js';
import { ageVersionSupported, LocalEncryptionEngine } from '../src/modules/backup/encryption.js';
import { PostgresBackupRepository } from '../src/modules/backup/repository.js';
import { BackupService } from '../src/modules/backup/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

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

function resolveTool(envKey: string, fallback: string): string {
  const override = process.env[envKey]?.trim();
  return override && override.length > 0 ? override : fallback;
}

describe.skipIf(!databaseUrl)('BR3 local encryption engine (PostgreSQL + real age integration)', () => {
  const admin = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  let sourceDb = '';
  let sourceUrl = '';
  let sourcePool: Pool | null = null;
  let repository: PostgresBackupRepository | null = null;
  let service: BackupService | null = null;
  let engineRoot: string;
  let tempRoot: string;
  let keyDir: string;
  let recipient = '';
  let identityPath = '';
  let ageBin = '';
  let inspectBin = '';
  let clock = Date.parse('2026-08-23T10:00:00Z');
  let adminActor: { id: string; organizationId: string };
  let runCount = 0;
  const failureSummaries: string[] = [];

  const actorOf = () => ({
    id: adminActor.id,
    organizationId: adminActor.organizationId,
    name: 'BR3 Admin',
    email: 'br3-admin@test.local',
    role: 'ADMIN' as const,
    mustChangePassword: false,
    isActive: true,
    version: 1,
  });

  const createRun = async (scope: 'DATABASE' | 'FULL_DATA' = 'DATABASE') => {
    runCount += 1;
    const created = await service!.requestManualBackup(actorOf(), {
      clientActionId: `br3-${runCount}-${randomUUID().slice(0, 8)}`,
      scope,
    });
    return created.id as string;
  };

  const buildBackupEngine = (overrides: { filesRoot?: string | null } = {}) =>
    new LocalBackupEngine({
      repository: repository!,
      service: service!,
      pool: sourcePool!,
      databaseUrl: sourceUrl,
      tempRoot,
      filesRoot: overrides.filesRoot !== undefined ? overrides.filesRoot : null,
      now: () => new Date((clock += 1_000)),
      application: { applicationVersion: 'test-0.1.0', gitCommit: 'b'.repeat(40) },
    });

  const buildEncryptor = (recipientOverride?: string | null) =>
    new LocalEncryptionEngine({
      repository: repository!,
      service: service!,
      tempRoot,
      recipient: recipientOverride !== undefined ? recipientOverride : recipient,
    });

  /** BR2 package for a fresh run: RUNNING @ PACKAGE with <run-id>.sbk.tar. */
  const packRun = async (filesRoot?: string | null) => {
    const runId = await createRun(filesRoot ? 'FULL_DATA' : 'DATABASE');
    const result = await buildBackupEngine({ filesRoot }).buildLocalBackup(runId);
    if (result.outcome !== 'packaged') throw new Error(`BR2 packaging failed: ${result.failureCode}`);
    return { runId, packagePath: result.packagePath };
  };

  // Successful runs stay RUNNING (now @ ENCRYPT) and hold the single-active
  // slot; the suite releases the slot after asserting each success.
  const releaseSlot = async (runId: string) => {
    await service!.markCancelled(runId);
  };

  beforeAll(async () => {
    if (!admin) return;
    engineRoot = await mkdtemp(path.join(tmpdir(), 'servora-br3-'));
    tempRoot = path.join(engineRoot, 'workspaces');

    // Real, official age toolchain (>= 1.3 for native hybrid recipients).
    ageBin = resolveTool('AGE_BIN', 'age');
    const keygenBin = resolveTool('AGE_KEYGEN_BIN', 'age-keygen');
    inspectBin = resolveTool('AGE_INSPECT_BIN', 'age-inspect');
    const ageVersion = await promisifiedExecFile(ageBin, ['--version']);
    const parsed = /(\d+)\.(\d+)/.exec(ageVersion.stdout.trim());
    if (!parsed || !ageVersionSupported({ major: Number(parsed[1]), minor: Number(parsed[2]) })) {
      throw new Error(
        `BR3 integration tests require the official age CLI >= 1.3.0 (native hybrid recipients); `
        + `got: ${ageVersion.stdout.trim()}. Install age 1.3.1 or set AGE_BIN/AGE_KEYGEN_BIN/AGE_INSPECT_BIN.`,
      );
    }

    // Ephemeral test-only key material in a disposable 0700 directory.
    keyDir = await mkdtemp(path.join(engineRoot, 'keys-'));
    await chmod(keyDir, 0o700);
    identityPath = path.join(keyDir, 'identity.txt');
    await promisifiedExecFile(keygenBin, ['-pq', '-o', identityPath]);
    await chmod(identityPath, 0o600);
    recipient = (await promisifiedExecFile(keygenBin, ['-y', identityPath])).stdout.trim();
    expect(recipient.startsWith('age1pq1')).toBe(true);

    sourceDb = `servora_br3_src_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await admin.query(`CREATE DATABASE ${sourceDb}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${sourceDb}`;
    sourceUrl = url.toString();
    sourcePool = new Pool({ connectionString: sourceUrl });
    await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(sourcePool) });

    const org = (await sourcePool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone) VALUES ('BR3 Fixture Org', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!;
    const adminUser = (await sourcePool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'BR3 Admin', $2, 'hash', 'ADMIN') RETURNING id`,
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

  it('happy path: PACKAGE → ENCRYPT, binary artifact, plaintext kept, nothing persisted', async () => {
    const { runId, packagePath } = await packRun();
    const plaintextHash = await streamHash(packagePath);

    const result = await buildEncryptor().encryptLocalBackup(runId);
    expect(result.outcome).toBe('encrypted');
    if (result.outcome !== 'encrypted') return;

    // State machine contract: RUNNING @ ENCRYPT, no SUCCESS-side evidence.
    const run = await repository!.findRunById(runId);
    expect(run).toMatchObject({
      status: 'RUNNING',
      phase: 'ENCRYPT',
      verifiedAt: null,
      sha256: null,
      remoteKey: null,
      sizeBytes: null,
      warningCode: null,
      failureCode: null,
    });

    expect(result.encryptedPath).toBe(path.join(tempRoot, runId, 'package', `${runId}.sbk.age`));
    expect(path.basename(result.encryptedPath)).toBe(`${runId}.sbk.age`);
    expect(result.recipientType).toBe('MLKEM768_X25519');
    expect(result.ageVersion).toMatch(/1\.\d+/);

    const cipherStat = await stat(result.encryptedPath);
    expect(cipherStat.size).toBeGreaterThan(0);
    expect(cipherStat.size).toBe(result.ciphertextBytes);
    expect(cipherStat.mode & 0o777).toBe(0o600);

    // Local expected hash: 64 lowercase hex, equals an independent re-hash.
    expect(result.localCiphertextSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await streamHash(result.encryptedPath)).toBe(result.localCiphertextSha256);

    // No partial left behind; plaintext package MUST remain (BR4 upload source).
    expect(await stat(`${result.encryptedPath}.partial`).then(() => true, () => false)).toBe(false);
    expect(await stat(packagePath).then(() => true, () => false)).toBe(true);
    expect(await streamHash(packagePath)).toBe(plaintextHash);

    // Plaintext and ciphertext are genuinely different encodings.
    expect(cipherStat.size).not.toBe((await stat(packagePath)).size);

    await releaseSlot(runId);
  });

  it('round trip: decrypt with the ephemeral hybrid identity restores the exact BR2 package', async () => {
    const { runId, packagePath } = await packRun();
    const result = await buildEncryptor().encryptLocalBackup(runId);
    if (result.outcome !== 'encrypted') throw new Error('encryption failed');

    const decrypted = path.join(engineRoot, `decrypted-${runId}.tar`);
    await promisifiedExecFile(ageBin, ['--decrypt', '-i', identityPath, '-o', decrypted, result.encryptedPath]);
    expect(await streamHash(decrypted)).toBe(await streamHash(packagePath));

    // Inner BR2 structure remains valid after the round trip.
    const extract = path.join(engineRoot, `extract-${runId}`);
    await mkdir(extract, { recursive: true });
    await promisifiedExecFile(process.env.TAR_BIN ?? 'tar', ['-x', '-f', decrypted, '-C', extract]);
    const manifest = JSON.parse(await readFile(path.join(extract, 'manifest.json'), 'utf8'));
    expect(manifest.format).toBe('servora-backup');
    expect(manifest.backupId).toBe(runId);
    expect(JSON.stringify(manifest)).not.toContain('AGE-SECRET-KEY');
    const dumpHash = await streamHash(path.join(extract, 'database.dump'));
    const checksums = await readFile(path.join(extract, 'checksums.sha256'), 'utf8');
    expect(checksums.trim()).toBe(`${dumpHash}  database.dump`);
    const listing = await promisifiedExecFile(process.env.PG_RESTORE_BIN ?? 'pg_restore',
      ['-l', path.join(extract, 'database.dump')]);
    expect(listing.stdout).toContain('Dumped by pg_dump version');

    await rm(extract, { recursive: true, force: true });
    await rm(decrypted, { force: true });
    await releaseSlot(runId);
  });

  it('post-quantum contract: age-inspect reports the native hybrid recipient (mlkem768x25519)', async () => {
    const { runId } = await packRun();
    const result = await buildEncryptor().encryptLocalBackup(runId);
    if (result.outcome !== 'encrypted') throw new Error('encryption failed');

    const inspection = JSON.parse(
      (await promisifiedExecFile(inspectBin, ['--json', result.encryptedPath])).stdout,
    ) as { postquantum?: string; stanza_types?: string[] };
    expect(inspection.postquantum).toBe('yes');
    expect(inspection.stanza_types).toContain('mlkem768x25519');

    await releaseSlot(runId);
  });

  it('ciphertext hash: single-byte modification changes the hash and breaks decryption', async () => {
    const { runId } = await packRun();
    const result = await buildEncryptor().encryptLocalBackup(runId);
    if (result.outcome !== 'encrypted') throw new Error('encryption failed');

    const tampered = path.join(engineRoot, `tampered-${runId}.age`);
    await copyFile(result.encryptedPath, tampered);
    const buffer = Buffer.from(await readFile(tampered));
    buffer[buffer.length - 1]! ^= 0xff;
    await writeFile(tampered, buffer);

    expect(await streamHash(tampered)).not.toBe(result.localCiphertextSha256);
    await expect(promisifiedExecFile(ageBin,
      ['--decrypt', '-i', identityPath, '-o', path.join(engineRoot, `bad-${runId}.tar`), tampered]))
      .rejects.toThrow();
    await rm(tampered, { force: true });
    await releaseSlot(runId);
  });

  it('age binary missing maps to ENCRYPTION_FAILED with no artifact', async () => {
    const prev = process.env.AGE_BIN;
    process.env.AGE_BIN = '/nonexistent/age-xyz';
    try {
      const { runId } = await packRun();
      const result = await buildEncryptor().encryptLocalBackup(runId);
      expect(result).toMatchObject({ outcome: 'failed', failureCode: 'ENCRYPTION_FAILED' });
      failureSummaries.push(result.outcome === 'failed' ? result.failureSummary : '');
      const run = await repository!.findRunById(runId);
      expect(run).toMatchObject({ status: 'FAILED', failureCode: 'ENCRYPTION_FAILED', verifiedAt: null, sha256: null });
      expect(await stat(path.join(tempRoot, runId)).then(() => true, () => false)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.AGE_BIN;
      else process.env.AGE_BIN = prev;
    }
  });

  it('age older than 1.3 fails closed with operator guidance (no classic fallback)', async () => {
    const shim = path.join(engineRoot, 'age-old.sh');
    await writeFile(shim, '#!/bin/sh\necho "v1.2.1"\n', { mode: 0o755 });
    const prev = process.env.AGE_BIN;
    process.env.AGE_BIN = shim;
    try {
      const { runId } = await packRun();
      const result = await buildEncryptor().encryptLocalBackup(runId);
      expect(result).toMatchObject({ outcome: 'failed', failureCode: 'ENCRYPTION_FAILED' });
      failureSummaries.push(result.outcome === 'failed' ? result.failureSummary : '');
      if (result.outcome === 'failed') expect(result.failureSummary).toMatch(/1\.3\.0/);
      expect((await repository!.findRunById(runId))?.status).toBe('FAILED');
      expect(await stat(path.join(tempRoot, runId)).then(() => true, () => false)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.AGE_BIN;
      else process.env.AGE_BIN = prev;
    }
  });

  it.each([
    ['classic X25519 recipient', `age1${'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2)}`],
    ['SSH recipient', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample'],
    ['plugin recipient', 'age1yubikey1qpzry9x8gf2tvdw0s3jn54khce6mua7'],
    ['malformed recipient', 'not-a-recipient'],
  ])('rejects %s (fail closed, no downgrade)', async (_label, badRecipient) => {
    const { runId } = await packRun();
    const result = await buildEncryptor(badRecipient).encryptLocalBackup(runId);
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'ENCRYPTION_FAILED' });
    failureSummaries.push(result.outcome === 'failed' ? result.failureSummary : '');
    const run = await repository!.findRunById(runId);
    expect(run).toMatchObject({ status: 'FAILED', failureCode: 'ENCRYPTION_FAILED' });
    expect(run?.verifiedAt).toBeNull();
    expect(run?.sha256).toBeNull();
    expect(await stat(path.join(tempRoot, runId)).then(() => true, () => false)).toBe(false);
  });

  it('missing recipient configuration maps to ENCRYPTION_FAILED', async () => {
    const { runId } = await packRun();
    const result = await buildEncryptor(null).encryptLocalBackup(runId);
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'ENCRYPTION_FAILED' });
    failureSummaries.push(result.outcome === 'failed' ? result.failureSummary : '');
    expect((await repository!.findRunById(runId))?.status).toBe('FAILED');
  });

  it('age process failure leaves no final artifact and removes the workspace', async () => {
    const shim = path.join(engineRoot, 'age-fail.sh');
    await writeFile(shim, '#!/bin/sh\ncase "$1" in --version) echo "v1.3.1"; exit 0;; *) echo "boom" >&2; exit 1;; esac\n', { mode: 0o755 });
    const prev = process.env.AGE_BIN;
    process.env.AGE_BIN = shim;
    try {
      const { runId } = await packRun();
      const result = await buildEncryptor().encryptLocalBackup(runId);
      expect(result).toMatchObject({ outcome: 'failed', failureCode: 'ENCRYPTION_FAILED' });
      failureSummaries.push(result.outcome === 'failed' ? result.failureSummary : '');
      const run = await repository!.findRunById(runId);
      expect(run).toMatchObject({
        status: 'FAILED',
        failureCode: 'ENCRYPTION_FAILED',
        verifiedAt: null,
        sha256: null,
        warningCode: null,
      });
      // Partial removed best-effort together with the sensitive workspace.
      expect(await stat(path.join(tempRoot, runId)).then(() => true, () => false)).toBe(false);
      if (result.outcome === 'failed') {
        expect(result.diagnostics ?? '').not.toMatch(/AGE-SECRET-KEY/);
        expect(result.failureSummary).not.toMatch(/AGE-SECRET-KEY/);
      }
    } finally {
      if (prev === undefined) delete process.env.AGE_BIN;
      else process.env.AGE_BIN = prev;
    }
  });

  it('ciphertext output creation failure maps to ENCRYPTION_FAILED (no final exposed)', async () => {
    const { runId } = await packRun();
    const packageDir = path.join(tempRoot, runId, 'package');
    await chmod(packageDir, 0o500);
    try {
      const result = await buildEncryptor().encryptLocalBackup(runId);
      expect(result).toMatchObject({ outcome: 'failed', failureCode: 'ENCRYPTION_FAILED' });
      failureSummaries.push(result.outcome === 'failed' ? result.failureSummary : '');
      expect((await repository!.findRunById(runId))?.status).toBe('FAILED');
      expect(await stat(path.join(packageDir, `${runId}.sbk.age`)).then(() => true, () => false)).toBe(false);
    } finally {
      await chmod(packageDir, 0o700);
    }
  });

  it('pre-existing FINAL output fails closed: preserved, not overwritten', async () => {
    const { runId, packagePath } = await packRun();
    const finalPath = path.join(tempRoot, runId, 'package', `${runId}.sbk.age`);
    await writeFile(finalPath, 'preexisting-final', { mode: 0o600 });

    const result = await buildEncryptor().encryptLocalBackup(runId);
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'ENCRYPTION_FAILED' });
    failureSummaries.push(result.outcome === 'failed' ? result.failureSummary : '');
    expect(await readFile(finalPath, 'utf8')).toBe('preexisting-final');
    expect((await repository!.findRunById(runId))?.status).toBe('FAILED');
    // Fail closed: the ambiguous workspace (incl. the plaintext package) is
    // deliberately preserved for BR5 recovery.
    expect(await stat(packagePath).then(() => true, () => false)).toBe(true);
    await rm(path.join(tempRoot, runId), { recursive: true, force: true });
  });

  it('pre-existing PARTIAL output fails closed: preserved, not overwritten', async () => {
    const { runId, packagePath } = await packRun();
    const partialPath = path.join(tempRoot, runId, 'package', `${runId}.sbk.age.partial`);
    await writeFile(partialPath, 'preexisting-partial', { mode: 0o600 });

    const result = await buildEncryptor().encryptLocalBackup(runId);
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'ENCRYPTION_FAILED' });
    failureSummaries.push(result.outcome === 'failed' ? result.failureSummary : '');
    expect(await readFile(partialPath, 'utf8')).toBe('preexisting-partial');
    expect(await stat(path.join(tempRoot, runId, 'package', `${runId}.sbk.age`)).then(() => true, () => false))
      .toBe(false);
    expect(await stat(packagePath).then(() => true, () => false)).toBe(true);
    await rm(path.join(tempRoot, runId), { recursive: true, force: true });
  });

  it('engine refuses runs that are not RUNNING @ PACKAGE', async () => {
    const runId = await createRun();
    await expect(buildEncryptor().encryptLocalBackup(runId)).rejects.toThrow(/PACKAGE/);
    await service!.startRun(runId);
    await expect(buildEncryptor().encryptLocalBackup(runId)).rejects.toThrow(/PACKAGE/);
    await service!.markCancelled(runId);
    await expect(buildEncryptor().encryptLocalBackup(runId)).rejects.toThrow(/PACKAGE/);
  });

  it('large package proves streaming/bounded-memory encryption (64 MiB incompressible)', async () => {
    const bigRoot = path.join(engineRoot, 'big-files');
    await mkdir(bigRoot, { recursive: true });
    const bigPath = path.join(bigRoot, 'random.bin');
    const handle = await import('node:fs/promises').then((fs) => fs.open(bigPath, 'w'));
    try {
      for (let written = 0; written < 64; written += 1) {
        await handle.write(randomBytes(1024 * 1024));
      }
    } finally {
      await handle.close();
    }

    const { runId, packagePath } = await packRun(bigRoot);
    const packageHash = await streamHash(packagePath);
    expect((await stat(packagePath)).size).toBeGreaterThan(60 * 1024 * 1024);

    const result = await buildEncryptor().encryptLocalBackup(runId);
    expect(result.outcome).toBe('encrypted');
    if (result.outcome !== 'encrypted') return;
    expect(result.ciphertextBytes).toBeGreaterThan(60 * 1024 * 1024);
    expect(await streamHash(result.encryptedPath)).toBe(result.localCiphertextSha256);

    const decrypted = path.join(engineRoot, `big-decrypted-${runId}.tar`);
    await promisifiedExecFile(ageBin, ['--decrypt', '-i', identityPath, '-o', decrypted, result.encryptedPath]);
    expect(await streamHash(decrypted)).toBe(packageHash);

    await rm(decrypted, { force: true });
    await releaseSlot(runId);
    await rm(bigRoot, { recursive: true, force: true });
  });

  it('key material privacy: no identity columns, sanitized failure surface', async () => {
    const identityColumns = await sourcePool!.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('backup_runs', 'backup_storage', 'backup_policy', 'restore_runs')
          AND (column_name ILIKE '%identity%' OR column_name ILIKE '%secret%' OR column_name ILIKE '%private%')`,
    );
    expect(identityColumns.rows).toEqual([]);

    for (const summary of failureSummaries) {
      expect(summary).not.toContain('AGE-SECRET-KEY');
      expect(summary).not.toContain(recipient);
    }
  });
});
