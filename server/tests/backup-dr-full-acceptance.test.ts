import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { getMigrationsDirectory } from '../src/db/schema-compatibility.js';
import { createPostgresReadiness } from '../src/modules/health/postgres-readiness.js';
import { PostgresAuthRepository } from '../src/modules/auth/repository.js';
import { hashPassword } from '../src/modules/auth/crypto.js';
import { LocalBackupEngine } from '../src/modules/backup/engine.js';
import { LocalEncryptionEngine, ageVersionSupported } from '../src/modules/backup/encryption.js';
import { createBackupPipelineExecutor } from '../src/modules/backup/pipeline.js';
import { CloudflareR2Storage, type R2SendableClient } from '../src/modules/backup/r2.js';
import { buildR2Endpoint } from '../src/modules/backup/r2-config.js';
import { PostgresBackupRepository } from '../src/modules/backup/repository.js';
import { BackupService } from '../src/modules/backup/service.js';
import { BackupWorker } from '../src/modules/backup/worker.js';
import { buildRemoteObjectKey } from '../src/modules/backup/object-keys.js';
import { RestoreService } from '../src/modules/backup/restore/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const serverDirectory = fileURLToPath(new URL('..', import.meta.url));
const restoreCliEntrypoint = fileURLToPath(new URL('../bin/servora-backup.js', import.meta.url));
const deterministicInstanceId = 'br7-e2e-synthetic-01';

type AcceptanceR2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

type RealR2Evidence = {
  acceptanceVersion: 1;
  timestamp: string;
  gitCommit: string | null;
  result: 'PASS' | 'FAIL';
  failureGate: string | null;
  backupId: string | null;
  opaqueInstanceId: string;
  sourceDatabase: string;
  targetDatabase: string;
  backupScope: 'FULL_DATA';
  cloudProvider: 'Cloudflare R2';
  endpointFamily: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com';
  schemaVersion: string | null;
  ciphertextBytes: number | null;
  bucket: string;
  objectKey: string | null;
  putObjectPassed: boolean;
  headObjectPassed: boolean;
  getObjectPassed: boolean;
  listObjectsV2Passed: boolean;
  customMetadataPassed: boolean;
  streamedCiphertextSha256Passed: boolean;
  remoteChecksumVerified: boolean;
  listRemotePassed: boolean;
  verifyPassed: boolean;
  inspectPassed: boolean;
  ageDecryptPassed: boolean;
  manifestPassed: boolean;
  componentChecksumsPassed: boolean;
  sourceMetadataUnavailable: boolean;
  restorePassed: boolean;
  newTargetRestorePassed: boolean;
  schemaValidationPassed: boolean;
  domainValidationPassed: boolean;
  apiHealthPassed: boolean;
  authenticationPassed: boolean;
  authenticatedReadPassed: boolean;
  fullDataPassed: boolean;
  readyForCutover: boolean;
  realR2: true;
  etagCanonicalIntegrityInput: false;
  producerSignaturePresent: false;
  productionCutoverPerformed: false;
  productionWorkerEnablementPerformed: false;
  r2Cleanup: 'PENDING' | 'DELETED' | 'RETAINED_OR_LOCKED' | 'NOT_CREATED' | 'CLEANUP_UNVERIFIED';
  timingsMs: {
    backup: number | null;
    restore: number | null;
    api: number | null;
  };
};

function acceptanceR2Config(): AcceptanceR2Config {
  const accountId = process.env.SERVORA_ACCEPTANCE_R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.SERVORA_ACCEPTANCE_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.SERVORA_ACCEPTANCE_R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.SERVORA_ACCEPTANCE_R2_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error('dedicated real R2 acceptance configuration is incomplete');
  }
  if (process.env.SERVORA_ACCEPTANCE_REAL_R2_CONFIRM !== 'explicit-operator-opt-in') {
    throw new Error('real R2 acceptance requires the explicit operator opt-in');
  }
  if (process.env.BACKUP_R2_BUCKET?.trim() === bucket) {
    throw new Error('acceptance bucket must be production-distinct');
  }
  if (process.env.BACKUP_R2_ACCESS_KEY_ID?.trim() === accessKeyId
    && process.env.BACKUP_R2_SECRET_ACCESS_KEY?.trim() === secretAccessKey) {
    throw new Error('acceptance credentials must be production-distinct');
  }
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

function gitCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: serverDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function runRestoreCli<T>(args: string[], env: NodeJS.ProcessEnv): T {
  const output = execFileSync(
    process.execPath,
    [restoreCliEntrypoint, ...args],
    {
      cwd: serverDirectory,
      env,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
  const finalLine = output.split('\n').at(-1);
  if (!finalLine) throw new Error('restore CLI returned no JSON output');
  return JSON.parse(finalLine) as T;
}

async function persistEvidence(
  evidenceDirectory: string,
  evidenceFile: string,
  evidence: RealR2Evidence,
): Promise<string> {
  if (!path.isAbsolute(evidenceDirectory) || /[\n\r\0]/.test(evidenceDirectory)) {
    throw new Error('SERVORA_ACCEPTANCE_EVIDENCE_DIR must be an absolute safe path');
  }
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(evidenceDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('acceptance evidence directory must be a real directory');
  }
  const destination = path.join(evidenceDirectory, evidenceFile);
  const partial = `${destination}.partial-${randomUUID()}`;
  await writeFile(partial, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(partial, destination);
  return destination;
}

function initialRealR2Evidence(input: {
  instanceId: string;
  sourceDatabase: string;
  targetDatabase: string;
  bucket: string;
}): RealR2Evidence {
  return {
    acceptanceVersion: 1,
    timestamp: new Date().toISOString(),
    gitCommit: gitCommit(),
    result: 'FAIL',
    failureGate: 'ACCEPTANCE_EXECUTION',
    backupId: null,
    opaqueInstanceId: input.instanceId,
    sourceDatabase: input.sourceDatabase,
    targetDatabase: input.targetDatabase,
    backupScope: 'FULL_DATA',
    cloudProvider: 'Cloudflare R2',
    endpointFamily: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com',
    schemaVersion: null,
    ciphertextBytes: null,
    bucket: input.bucket,
    objectKey: null,
    putObjectPassed: false,
    headObjectPassed: false,
    getObjectPassed: false,
    listObjectsV2Passed: false,
    customMetadataPassed: false,
    streamedCiphertextSha256Passed: false,
    remoteChecksumVerified: false,
    listRemotePassed: false,
    verifyPassed: false,
    inspectPassed: false,
    ageDecryptPassed: false,
    manifestPassed: false,
    componentChecksumsPassed: false,
    sourceMetadataUnavailable: false,
    restorePassed: false,
    newTargetRestorePassed: false,
    schemaValidationPassed: false,
    domainValidationPassed: false,
    apiHealthPassed: false,
    authenticationPassed: false,
    authenticatedReadPassed: false,
    fullDataPassed: false,
    readyForCutover: false,
    realR2: true,
    etagCanonicalIntegrityInput: false,
    producerSignaturePresent: false,
    productionCutoverPerformed: false,
    productionWorkerEnablementPerformed: false,
    r2Cleanup: 'NOT_CREATED',
    timingsMs: { backup: null, restore: null, api: null },
  };
}

type StoredObject = { content: Buffer; metadata: Record<string, string> };

class DeterministicR2Client implements R2SendableClient {
  readonly objects = new Map<string, StoredObject>();

  async send(command: unknown): Promise<unknown> {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    if (name === 'PutObjectCommand') {
      const body = input.Body as AsyncIterable<Uint8Array>;
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      this.objects.set(String(input.Key), { content: Buffer.concat(chunks), metadata: (input.Metadata ?? {}) as Record<string, string> });
      return {};
    }
    if (name === 'HeadObjectCommand') {
      const object = this.objects.get(String(input.Key));
      if (!object) throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      return { ContentLength: object.content.length, Metadata: object.metadata, ETag: '"diagnostic-etag"' };
    }
    if (name === 'GetObjectCommand') {
      const object = this.objects.get(String(input.Key));
      if (!object) throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      return {
        ContentLength: object.content.length,
        Metadata: object.metadata,
        Body: (async function* body() {
          for (let offset = 0; offset < object.content.length; offset += 32 * 1024) {
            yield object.content.subarray(offset, offset + 32 * 1024);
          }
        })(),
      };
    }
    if (name === 'ListObjectsV2Command') {
      const prefix = String(input.Prefix ?? '');
      return {
        Contents: [...this.objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ Key: key, Size: this.objects.get(key)!.content.length, ETag: '"diagnostic-etag"' })),
      };
    }
    throw new Error(`unsupported deterministic R2 operation: ${name}`);
  }
}

const testConfig = {
  nodeEnv: 'test' as const,
  host: '127.0.0.1', port: 0, databaseUrl: 'postgresql://restored-target', logLevel: 'silent',
  corsOrigin: 'http://127.0.0.1:5173', sessionTtlSeconds: 28_800, loginRateLimitMax: 5,
  rateLimitWindowMs: 60_000, trustedProxy: 'loopback' as const, healthSchemaVersion: null,
  actionScopedGeolocationEnabled: false, reverseGeocoderProvider: null, googleGeocodingApiKey: null,
  reverseGeocoderTimeoutMs: 2_000, geocodingUserDailyLimit: 15,
  geocodingOrganizationDailyLimit: 250, geocodingGlobalMonthlyLimit: 8_000,
  webPush: { enabled: false, vapidSubject: null, vapidPublicKey: null, vapidPrivateKey: null },
  backupLocalEngine: { tempRoot: null, filesRoot: null },
  backupEncryption: { recipient: null },
  backupR2: { accountId: null, accessKeyId: null, secretAccessKey: null, bucket: null, bucketAlias: null, instanceId: null },
};

function toolAvailable(binary: string): boolean {
  try { execFileSync(binary, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe.skipIf(
  !databaseUrl || process.env.BR7_FULL_DR_ACCEPTANCE !== '1'
    || !toolAvailable(process.env.AGE_BIN ?? 'age')
    || !toolAvailable(process.env.AGE_KEYGEN_BIN ?? 'age-keygen'),
)('BR7 full DR acceptance (real PostgreSQL + real age + deterministic/opt-in real R2)', () => {
  it('proves BR2→BR5 backup, source metadata loss, BR7 restore, API health and auth', async () => {
    const realR2 = process.env.SERVORA_ACCEPTANCE_REAL_R2 === '1';
    const r2Config = realR2
      ? acceptanceR2Config()
      : {
          accountId: 'a'.repeat(32),
          accessKeyId: 'synthetic-key',
          secretAccessKey: 'synthetic-secret',
          bucket: 'br7-synthetic',
        };
    const instanceId = realR2
      ? `acceptance-${randomUUID().replaceAll('-', '').slice(0, 20)}`
      : deterministicInstanceId;
    if (realR2 && process.env.BACKUP_INSTANCE_ID?.trim()) {
      expect(instanceId).not.toBe(process.env.BACKUP_INSTANCE_ID.trim());
    }

    const root = await mkdtemp(path.join(os.tmpdir(), 'br7-full-dr-'));
    const sourceFilesRoot = path.join(root, 'source-files');
    const restoredFilesRoot = path.join(root, 'restored-files');
    if (realR2 && process.env.BACKUP_FILES_ROOT?.trim()) {
      const productionFilesRoot = path.resolve(process.env.BACKUP_FILES_ROOT.trim());
      expect(path.resolve(sourceFilesRoot)).not.toBe(productionFilesRoot);
      expect(path.resolve(restoredFilesRoot)).not.toBe(productionFilesRoot);
    }
    if (realR2) {
      const knownProductionDatabaseUrls = [
        process.env.DATABASE_URL,
        process.env.PRODUCTION_DATABASE_URL,
        process.env.RESTORE_PRODUCTION_DATABASE_URL,
      ].map((value) => value?.trim()).filter(Boolean);
      expect(knownProductionDatabaseUrls).not.toContain(databaseUrl!.trim());
    }
    const admin = new Pool({ connectionString: databaseUrl! });
    const sourceDb = `br7_e2e_src_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const targetDb = `br7_e2e_dst_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const keepTarget = process.env.SERVORA_ACCEPTANCE_KEEP_TARGET === '1';
    const evidenceDirectory = realR2 ? process.env.SERVORA_ACCEPTANCE_EVIDENCE_DIR?.trim() : null;
    if (realR2 && !evidenceDirectory) {
      throw new Error('SERVORA_ACCEPTANCE_EVIDENCE_DIR is required for real R2 acceptance');
    }
    const evidenceFile = `acceptance-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
    let evidence = realR2
      ? initialRealR2Evidence({
          instanceId,
          sourceDatabase: sourceDb,
          targetDatabase: targetDb,
          bucket: r2Config.bucket,
        })
      : null;
    let evidencePath: string | null = null;
    let remoteKey: string | null = null;
    let sourcePool: Pool | null = null;
    let targetPool: Pool | null = null;
    let app: Awaited<ReturnType<typeof buildApp>> | null = null;
    let storage: CloudflareR2Storage | null = null;
    let restoreStorage: CloudflareR2Storage | null = null;
    try {
      await admin.query(`CREATE DATABASE ${sourceDb}`);
      await mkdir(sourceFilesRoot, { recursive: true });
      await writeFile(path.join(sourceFilesRoot, 'payload.txt'), 'BR7 FULL_DATA synthetic payload\n');
      const sourceUrl = new URL(databaseUrl!);
      sourceUrl.pathname = `/${sourceDb}`;
      sourcePool = new Pool({ connectionString: sourceUrl.toString() });
      await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(sourcePool) });
      const org = (await sourcePool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('BR7 E2E Synthetic Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!;
      const password = 'BR7-Synthetic-Password-2026!';
      const email = `${randomUUID()}@br7.invalid`;
      const user = (await sourcePool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role, must_change_password)
         VALUES ($1, 'BR7 E2E Admin', $2, $3, 'ADMIN', FALSE) RETURNING id`,
        [org.id, email, await hashPassword(password)],
      )).rows[0]!;
      await sourcePool.query(
        `INSERT INTO customers (organization_id, name, customer_type) VALUES ($1, 'BR7 Synthetic Customer', 'clinic')`,
        [org.id],
      );

      const keyDir = await mkdtemp(path.join(root, 'keys-'));
      const identityPath = path.join(keyDir, 'identity.txt');
      execFileSync(process.env.AGE_KEYGEN_BIN ?? 'age-keygen', ['-pq', '-o', identityPath], { stdio: 'ignore' });
      const recipient = execFileSync(process.env.AGE_KEYGEN_BIN ?? 'age-keygen', ['-y', identityPath], { encoding: 'utf8' }).trim();
      const ageVersion = execFileSync(process.env.AGE_BIN ?? 'age', ['--version'], { encoding: 'utf8' });
      const parsedAge = /(\d+)\.(\d+)/.exec(ageVersion)!;
      expect(ageVersionSupported({ major: Number(parsedAge[1]), minor: Number(parsedAge[2]) })).toBe(true);

      const repository = new PostgresBackupRepository(sourcePool);
      const service = new BackupService(repository);
      const actor = { id: user.id, organizationId: org.id, name: 'BR7 E2E Admin', email, role: 'ADMIN' as const, mustChangePassword: false, isActive: true, version: 1 };
      const queued = await service.requestManualBackup(actor, { clientActionId: `br7-e2e-${randomUUID()}`, scope: 'FULL_DATA' });
      remoteKey = buildRemoteObjectKey({
        instanceId,
        retentionClass: 'MANUAL',
        backupId: queued.id,
      });
      if (evidence) {
        evidence.backupId = queued.id;
        evidence.objectKey = remoteKey;
        evidence.r2Cleanup = 'PENDING';
      }
      const r2Client = realR2 ? undefined : new DeterministicR2Client();
      storage = new CloudflareR2Storage({
        config: r2Config,
        ...(r2Client ? { client: r2Client } : {}),
      });
      const tempRoot = path.join(root, 'backup-workspaces');
      const worker = new BackupWorker({
        repository, service, enabled: true, now: () => new Date(), sleep: async () => undefined,
        executeRun: createBackupPipelineExecutor({
          repository, pool: sourcePool, service, databaseUrl: sourceUrl.toString(), tempRoot, filesRoot: sourceFilesRoot,
          recipient, storage, instanceId, application: { applicationVersion: 'br7-e2e', gitCommit: null },
        }),
      });
      if (realR2) {
        console.info([
          'acceptance bucket configured? YES',
          'acceptance credentials configured? YES',
          'explicit opt-in supplied? YES',
          'ephemeral age identity generated? YES',
          'source DB synthetic? YES',
          'acceptance instance ID production-distinct? YES',
        ].join('\n'));
      }
      if (evidence) evidence.failureGate = 'REMOTE_BACKUP';
      const backupStartedAt = Date.now();
      await expect(worker.runOnce()).resolves.toMatchObject({ kind: 'claimed', runId: queued.id });
      const completed = await repository.findRunById(queued.id);
      if (completed?.status !== 'SUCCESS' || !completed.verifiedAt) {
        throw new Error(
          `backup acceptance run failed at ${completed?.phase ?? 'UNKNOWN'} (${completed?.failureCode ?? 'UNKNOWN'})`,
        );
      }
      expect(completed).toMatchObject({ status: 'SUCCESS', verifiedAt: expect.any(Date) });
      expect(completed?.remoteKey).toBe(remoteKey);
      if (evidence) {
        evidence.ciphertextBytes = completed?.sizeBytes ?? null;
        evidence.putObjectPassed = true;
        evidence.headObjectPassed = true;
        evidence.getObjectPassed = true;
        evidence.customMetadataPassed = true;
        evidence.streamedCiphertextSha256Passed = true;
        evidence.remoteChecksumVerified = true;
        evidence.timingsMs.backup = Date.now() - backupStartedAt;
      }
      if (evidence) evidence.failureGate = 'SOURCE_METADATA_LOSS';
      await sourcePool.end();
      sourcePool = null;
      await admin.query(`DROP DATABASE ${sourceDb}`);
      const unavailableSource = new Pool({ connectionString: sourceUrl.toString(), max: 1, connectionTimeoutMillis: 1_000 });
      try {
        await expect(unavailableSource.query('SELECT 1')).rejects.toBeDefined();
      } finally {
        await unavailableSource.end().catch(() => undefined);
      }
      await rm(sourceFilesRoot, { recursive: true, force: true });
      if (evidence) evidence.sourceMetadataUnavailable = true;

      let restored: {
        outcome: 'READY_FOR_CUTOVER';
        evidence: { schemaVersion: string; fullDataRestored: boolean };
      };
      const restoreStartedAt = Date.now();
      if (realR2) {
        const cliEnv: NodeJS.ProcessEnv = {
          ...process.env,
          BACKUP_R2_ACCOUNT_ID: r2Config.accountId,
          BACKUP_R2_ACCESS_KEY_ID: r2Config.accessKeyId,
          BACKUP_R2_SECRET_ACCESS_KEY: r2Config.secretAccessKey,
          BACKUP_R2_BUCKET: r2Config.bucket,
          BACKUP_INSTANCE_ID: instanceId,
          RESTORE_TARGET_DATABASE_URL: databaseUrl!,
          PRODUCTION_DATABASE_URL: sourceUrl.toString(),
          RESTORE_WORKSPACE_ROOT: path.join(root, 'restore-workspaces'),
          RESTORE_EVIDENCE_DIR: path.join(root, 'restore-evidence'),
          BACKUP_FILES_ROOT: sourceFilesRoot,
        };
        delete cliEnv.DATABASE_URL;
        delete cliEnv.RESTORE_CONTROL_DATABASE_URL;
        delete cliEnv.SERVORA_BACKUP_AGE_IDENTITY;
        delete cliEnv.AGE_IDENTITY_FILE;
        delete cliEnv.SERVORA_ACCEPTANCE_R2_ACCOUNT_ID;
        delete cliEnv.SERVORA_ACCEPTANCE_R2_BUCKET;
        delete cliEnv.SERVORA_ACCEPTANCE_R2_ACCESS_KEY_ID;
        delete cliEnv.SERVORA_ACCEPTANCE_R2_SECRET_ACCESS_KEY;
        delete cliEnv.SERVORA_ACCEPTANCE_R2_SESSION_TOKEN;

        evidence!.failureGate = 'REMOTE_LIST';
        const listed = runRestoreCli<{ items: Array<{ backupId: string }>; pages: number }>(
          ['list', '--remote', '--json'],
          cliEnv,
        );
        expect(listed.items).toEqual(expect.arrayContaining([expect.objectContaining({ backupId: queued.id })]));
        evidence!.listObjectsV2Passed = true;
        evidence!.listRemotePassed = true;

        evidence!.failureGate = 'REMOTE_VERIFY';
        const verified = runRestoreCli<{ outcome: string; backupId: string; schemaVersion: string }>(
          ['verify', queued.id, '--remote', '--identity', identityPath, '--json'],
          cliEnv,
        );
        expect(verified).toMatchObject({ outcome: 'VERIFIED', backupId: queued.id });
        evidence!.ageDecryptPassed = true;
        evidence!.manifestPassed = true;
        evidence!.componentChecksumsPassed = true;
        evidence!.verifyPassed = true;

        evidence!.failureGate = 'REMOTE_INSPECT';
        const inspected = runRestoreCli<{ outcome: string; backupId: string }>(
          ['inspect', queued.id, '--remote', '--identity', identityPath, '--json'],
          cliEnv,
        );
        expect(inspected).toMatchObject({ outcome: 'INSPECTED', backupId: queued.id });
        evidence!.inspectPassed = true;

        evidence!.failureGate = 'REAL_DR_RESTORE';
        restored = runRestoreCli<typeof restored>([
          'restore',
          queued.id,
          '--remote',
          '--mode', 'disaster-recovery',
          '--target-db', targetDb,
          '--target-files-root', restoredFilesRoot,
          '--identity', identityPath,
          '--i-accept-destructive-restore',
          '--json',
        ], cliEnv);
      } else {
        restoreStorage = new CloudflareR2Storage({
          config: r2Config,
          ...(r2Client ? { client: r2Client } : {}),
        });
        const restoreService = new RestoreService({
          storage: restoreStorage,
          instanceId,
          identityPath,
          targetAdminDatabaseUrl: databaseUrl!,
          productionDatabaseUrl: sourceUrl.toString(),
          workspaceRoot: path.join(root, 'restore-workspaces'),
          filesRoot: sourceFilesRoot,
        });
        await expect(restoreService.listRemote()).resolves.toMatchObject({
          items: [expect.objectContaining({ backupId: queued.id })],
        });
        await expect(restoreService.verify({ archiveOrId: queued.id })).resolves.toMatchObject({
          outcome: 'VERIFIED', backupId: queued.id,
        });
        await expect(restoreService.inspect({ archiveOrId: queued.id })).resolves.toMatchObject({
          outcome: 'INSPECTED', backupId: queued.id,
        });
        restored = await restoreService.restore({
          archiveOrId: queued.id,
          mode: 'DISASTER_RECOVERY',
          targetDatabase: targetDb,
          targetFilesRoot: restoredFilesRoot,
          acknowledgeDestructiveRestore: true,
        });
      }
      expect(restored.outcome).toBe('READY_FOR_CUTOVER');
      await expect(readFile(path.join(restoredFilesRoot, 'payload.txt'), 'utf8'))
        .resolves.toBe('BR7 FULL_DATA synthetic payload\n');
      if (evidence) {
        evidence.newTargetRestorePassed = true;
        evidence.restorePassed = true;
        evidence.schemaVersion = restored.evidence.schemaVersion;
        evidence.schemaValidationPassed = true;
        evidence.fullDataPassed = restored.evidence.fullDataRestored;
        evidence.timingsMs.restore = Date.now() - restoreStartedAt;
      }

      const targetUrl = new URL(databaseUrl!);
      targetUrl.pathname = `/${targetDb}`;
      targetPool = new Pool({ connectionString: targetUrl.toString() });
      if (evidence) evidence.failureGate = 'DOMAIN_VALIDATION';
      await expect(targetPool.query(`SELECT name FROM organizations WHERE name = 'BR7 E2E Synthetic Org'`)).resolves.toMatchObject({ rows: [{ name: 'BR7 E2E Synthetic Org' }] });
      await expect(targetPool.query(
        `SELECT name FROM customers WHERE name = 'BR7 Synthetic Customer'`,
      )).resolves.toMatchObject({ rows: [{ name: 'BR7 Synthetic Customer' }] });
      if (evidence) evidence.domainValidationPassed = true;

      if (evidence) evidence.failureGate = 'ISOLATED_API_VALIDATION';
      const apiStartedAt = Date.now();
      const catalog = await loadMigrationCatalog(getMigrationsDirectory());
      expect(catalog.head).not.toBeNull();
      // BR7 contract: backup evidence metadata stays as separate assertion,
      // but runtime readiness authority is the current application MigrationCatalog.
      expect(restored.evidence.schemaVersion).toBe(catalog.head!.version);
      app = await buildApp(
        {
          ...testConfig,
          databaseUrl: targetUrl.toString(),
          healthSchemaVersion: catalog.head!.version,
        },
        {
          authRepository: new PostgresAuthRepository(targetPool),
          healthReadiness: createPostgresReadiness(targetPool, catalog),
        },
      );
      const apiAddress = await app.listen({ host: '127.0.0.1', port: 0 });
      const health = await fetch(`${apiAddress}/api/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({ status: 'ok' });
      if (evidence) evidence.apiHealthPassed = true;

      const login = await fetch(`${apiAddress}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: testConfig.corsOrigin },
        body: JSON.stringify({ email, password }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
      expect(cookie).toBeTruthy();
      if (evidence) evidence.authenticationPassed = true;
      const me = await fetch(`${apiAddress}/api/auth/me`, { headers: { cookie: cookie! } });
      expect(me.status).toBe(200);
      await expect(me.json()).resolves.toMatchObject({ user: { email, role: 'ADMIN' } });
      if (evidence) {
        evidence.authenticatedReadPassed = true;
        evidence.timingsMs.api = Date.now() - apiStartedAt;
        expect(evidence).toMatchObject({
          putObjectPassed: true,
          headObjectPassed: true,
          getObjectPassed: true,
          listObjectsV2Passed: true,
          customMetadataPassed: true,
          streamedCiphertextSha256Passed: true,
          remoteChecksumVerified: true,
          listRemotePassed: true,
          verifyPassed: true,
          inspectPassed: true,
          ageDecryptPassed: true,
          manifestPassed: true,
          componentChecksumsPassed: true,
          sourceMetadataUnavailable: true,
          newTargetRestorePassed: true,
          restorePassed: true,
          schemaValidationPassed: true,
          domainValidationPassed: true,
          apiHealthPassed: true,
          authenticationPassed: true,
          authenticatedReadPassed: true,
          fullDataPassed: true,
        });
        evidence.result = 'PASS';
        evidence.failureGate = null;
        evidence.readyForCutover = true;
        evidencePath = await persistEvidence(evidenceDirectory!, evidenceFile, evidence);
      }
    } catch (error) {
      if (evidence && evidenceDirectory) {
        evidence.result = 'FAIL';
        evidence.failureGate ??= 'ACCEPTANCE_EXECUTION';
        try {
          evidencePath = await persistEvidence(evidenceDirectory, evidenceFile, evidence);
        } catch {
          // Preserve the original acceptance failure; evidence IO is reported
          // by the missing file and must never expose the caught error.
        }
      }
      throw error;
    } finally {
      await app?.close().catch(() => undefined);
      await sourcePool?.end().catch(() => undefined);
      await targetPool?.end().catch(() => undefined);
      if (realR2 && remoteKey && storage) {
        const cleanupClient = new S3Client({
          region: 'auto',
          endpoint: buildR2Endpoint(r2Config.accountId),
          maxAttempts: 1,
          credentials: {
            accessKeyId: r2Config.accessKeyId,
            secretAccessKey: r2Config.secretAccessKey,
          },
        });
        try {
          const createdObject = await storage.headObject(remoteKey);
          if (!createdObject) {
            if (evidence) evidence.r2Cleanup = 'NOT_CREATED';
          } else {
            await cleanupClient.send(new DeleteObjectCommand({
              Bucket: r2Config.bucket,
              Key: remoteKey,
            }));
            const remaining = await storage.headObject(remoteKey);
            if (evidence) evidence.r2Cleanup = remaining ? 'RETAINED_OR_LOCKED' : 'DELETED';
          }
        } catch {
          if (evidence) evidence.r2Cleanup = 'CLEANUP_UNVERIFIED';
        } finally {
          cleanupClient.destroy();
        }
      }
      if (evidence && evidenceDirectory) {
        try {
          evidencePath = await persistEvidence(evidenceDirectory, evidenceFile, evidence);
        } catch {
          // Test outcome remains authoritative; never print raw filesystem or
          // SDK errors from cleanup/evidence finalization.
        }
      }
      if (evidencePath) console.info(`real R2 acceptance evidence: ${path.basename(evidencePath)}`);
      if (!keepTarget) await admin.query(`DROP DATABASE IF EXISTS ${targetDb}`).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${sourceDb}`).catch(() => undefined);
      await admin.end();
      storage?.destroy();
      restoreStorage?.destroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 600_000);
});
