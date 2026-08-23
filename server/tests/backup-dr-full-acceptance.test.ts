import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresAuthRepository } from '../src/modules/auth/repository.js';
import { hashPassword } from '../src/modules/auth/crypto.js';
import { LocalBackupEngine } from '../src/modules/backup/engine.js';
import { LocalEncryptionEngine, ageVersionSupported } from '../src/modules/backup/encryption.js';
import { createBackupPipelineExecutor } from '../src/modules/backup/pipeline.js';
import { CloudflareR2Storage, type R2SendableClient } from '../src/modules/backup/r2.js';
import { PostgresBackupRepository } from '../src/modules/backup/repository.js';
import { BackupService } from '../src/modules/backup/service.js';
import { BackupWorker } from '../src/modules/backup/worker.js';
import { RestoreService } from '../src/modules/backup/restore/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const deterministicInstanceId = 'br7-e2e-synthetic-01';

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
    const root = await mkdtemp(path.join(os.tmpdir(), 'br7-full-dr-'));
    const admin = new Pool({ connectionString: databaseUrl! });
    const sourceDb = `br7_e2e_src_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const targetDb = `br7_e2e_dst_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    let sourcePool: Pool | null = null;
    let targetPool: Pool | null = null;
    let app: Awaited<ReturnType<typeof buildApp>> | null = null;
    try {
      await admin.query(`CREATE DATABASE ${sourceDb}`);
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
      const queued = await service.requestManualBackup(actor, { clientActionId: `br7-e2e-${randomUUID()}`, scope: 'DATABASE' });
      const realR2 = process.env.BR7_REAL_R2_ACCEPTANCE === '1';
      const instanceId = realR2 ? process.env.BR7_REAL_R2_INSTANCE_ID ?? '' : deterministicInstanceId;
      if (realR2 && (!instanceId || !process.env.BACKUP_R2_ACCOUNT_ID || !process.env.BACKUP_R2_ACCESS_KEY_ID
        || !process.env.BACKUP_R2_SECRET_ACCESS_KEY || !process.env.BACKUP_R2_BUCKET)) {
        throw new Error('BR7_REAL_R2_ACCEPTANCE requires disposable R2 credentials and BR7_REAL_R2_INSTANCE_ID');
      }
      const r2Client = realR2 ? undefined : new DeterministicR2Client();
      const storage = new CloudflareR2Storage({
        config: realR2 ? {
          accountId: process.env.BACKUP_R2_ACCOUNT_ID!, accessKeyId: process.env.BACKUP_R2_ACCESS_KEY_ID!,
          secretAccessKey: process.env.BACKUP_R2_SECRET_ACCESS_KEY!, bucket: process.env.BACKUP_R2_BUCKET!,
        } : { accountId: 'a'.repeat(32), accessKeyId: 'synthetic-key', secretAccessKey: 'synthetic-secret', bucket: 'br7-synthetic' },
        ...(r2Client ? { client: r2Client } : {}),
      });
      const tempRoot = path.join(root, 'backup-workspaces');
      const worker = new BackupWorker({
        repository, service, enabled: true, now: () => new Date(), sleep: async () => undefined,
        executeRun: createBackupPipelineExecutor({
          repository, pool: sourcePool, service, databaseUrl: sourceUrl.toString(), tempRoot, filesRoot: null,
          recipient, storage, instanceId, application: { applicationVersion: 'br7-e2e', gitCommit: null },
        }),
      });
      await expect(worker.runOnce()).resolves.toMatchObject({ kind: 'claimed', runId: queued.id });
      const completed = await repository.findRunById(queued.id);
      expect(completed).toMatchObject({ status: 'SUCCESS', verifiedAt: expect.any(Date) });
      await sourcePool.end();
      sourcePool = null;
      await admin.query(`DROP DATABASE ${sourceDb}`);

      const restoreStorage = new CloudflareR2Storage({
        config: realR2 ? {
          accountId: process.env.BACKUP_R2_ACCOUNT_ID!, accessKeyId: process.env.BACKUP_R2_ACCESS_KEY_ID!,
          secretAccessKey: process.env.BACKUP_R2_SECRET_ACCESS_KEY!, bucket: process.env.BACKUP_R2_BUCKET!,
        } : { accountId: 'a'.repeat(32), accessKeyId: 'synthetic-key', secretAccessKey: 'synthetic-secret', bucket: 'br7-synthetic' },
        ...(r2Client ? { client: r2Client } : {}),
      });
      const restoreService = new RestoreService({
        storage: restoreStorage, instanceId, identityPath,
        targetAdminDatabaseUrl: databaseUrl!, productionDatabaseUrl: sourceUrl.toString(),
        workspaceRoot: path.join(root, 'restore-workspaces'),
      });
      await expect(restoreService.listRemote()).resolves.toMatchObject({ items: [expect.objectContaining({ backupId: queued.id })] });
      await expect(restoreService.verify({ archiveOrId: queued.id })).resolves.toMatchObject({ outcome: 'VERIFIED', backupId: queued.id });
      await expect(restoreService.inspect({ archiveOrId: queued.id })).resolves.toMatchObject({ outcome: 'INSPECTED', backupId: queued.id });
      const restored = await restoreService.restore({ archiveOrId: queued.id, mode: 'DISASTER_RECOVERY', targetDatabase: targetDb, acknowledgeDestructiveRestore: true });
      expect(restored.outcome).toBe('READY_FOR_CUTOVER');
      storage.destroy();
      restoreStorage.destroy();

      const targetUrl = new URL(databaseUrl!);
      targetUrl.pathname = `/${targetDb}`;
      targetPool = new Pool({ connectionString: targetUrl.toString() });
      await expect(targetPool.query(`SELECT name FROM organizations WHERE name = 'BR7 E2E Synthetic Org'`)).resolves.toMatchObject({ rows: [{ name: 'BR7 E2E Synthetic Org' }] });
      app = await buildApp(testConfig, { authRepository: new PostgresAuthRepository(targetPool) });
      await expect(app.inject({ method: 'GET', url: '/api/health' })).resolves.toMatchObject({ statusCode: 200 });
      await expect(app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).resolves.toMatchObject({ statusCode: 200 });
    } finally {
      await app?.close().catch(() => undefined);
      await sourcePool?.end().catch(() => undefined);
      await targetPool?.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${targetDb}`).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${sourceDb}`).catch(() => undefined);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
