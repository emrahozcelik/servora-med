import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { LocalBackupEngine } from '../src/modules/backup/engine.js';
import { ageVersionSupported, LocalEncryptionEngine } from '../src/modules/backup/encryption.js';
import { buildConnectionTestKey } from '../src/modules/backup/object-keys.js';
import { CloudflareR2Storage, type R2SendableClient } from '../src/modules/backup/r2.js';
import { RemoteBackupEngine } from '../src/modules/backup/remote-engine.js';
import { createBackupPipelineExecutor } from '../src/modules/backup/pipeline.js';
import { PostgresBackupRepository } from '../src/modules/backup/repository.js';
import { BackupService } from '../src/modules/backup/service.js';
import { BackupWorker } from '../src/modules/backup/worker.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const INSTANCE_ID = 'e2b1c3d4-test-inst-01';

function promisifiedExecFile(binary: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(binary, [...args], { shell: false, maxBuffer: 10_000_000, ...(env ? { env } : {}) },
      (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout: String(stdout), stderr: String(stderr) })));
  });
}

function resolveTool(envKey: string, fallback: string): string {
  const override = process.env[envKey]?.trim();
  return override && override.length > 0 ? override : fallback;
}

// ---------------------------------------------------------------------------
// Deterministic fake R2 object store (test-side; the ADAPTER under test
// streams — the fake is free to buffer).
// ---------------------------------------------------------------------------

type FakeObject = { content: Buffer; metadata: Record<string, string> };

function s3Error(name: string, status: number) {
  return Object.assign(new Error(`${name}`), { name, $metadata: { httpStatusCode: status } });
}
const notFound = () => s3Error('NotFound', 404);
const preconditionFailed = () => s3Error('PreconditionFailed', 412);
const transportError = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
const authError = () => s3Error('InvalidAccessKeyId', 403);

async function collectStream(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function chunked(content: Buffer, size: number): AsyncIterable<Uint8Array> {
  return (async function* generate() {
    for (let offset = 0; offset < content.length; offset += size) {
      yield content.subarray(offset, Math.min(offset + size, content.length));
    }
  })();
}

class FakeR2Store implements R2SendableClient {
  objects = new Map<string, FakeObject>();
  sessions = new Map<string, { key: string; metadata: Record<string, string> }>();
  calls: { op: string; key?: string; ifMatch?: string }[] = [];
  sendOptions: Array<{ abortSignal?: AbortSignal } | undefined> = [];
  failures = new Map<string, Array<() => void>>();
  afterStoreHooks: Array<(op: string, key: string) => void> = [];
  raceMode: 'none' | 'identical' | 'corrupt' = 'none';

  failNext(op: string, thrower: () => void) {
    const queue = this.failures.get(op) ?? [];
    queue.push(thrower);
    this.failures.set(op, queue);
  }

  private drain(op: string) {
    return this.failures.get(op)?.shift();
  }

  private async collectTracking(op: string, body: unknown): Promise<Buffer> {
    void op;
    return collectStream(body);
  }

  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    const op = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: { Key?: string; Body?: unknown; IfMatch?: string } }).input;
    this.calls.push({ op, key: input.Key, ifMatch: input.IfMatch });
    this.sendOptions.push(options);
    const fail = this.drain(op);
    if (fail) fail();

    switch (op) {
      case 'HeadObjectCommand': {
        const object = this.objects.get(input.Key!);
        if (!object) throw notFound();
        return { ContentLength: object.content.length, Metadata: { ...object.metadata }, ETag: '"fake-etag"' };
      }
      case 'PutObjectCommand': {
        const typed = (command as { input: { Key: string; Body: unknown; Metadata?: Record<string, string>; IfNoneMatch?: string } }).input;
        const content = await this.collectTracking(op, typed.Body);
        if (this.raceMode !== 'none') {
          // Simulate a concurrent writer completing this exact key first.
          const raced = this.raceMode === 'corrupt' ? Buffer.from(content) : content;
          if (this.raceMode === 'corrupt') raced[raced.length - 1]! ^= 0xff;
          this.objects.set(typed.Key, { content: raced, metadata: { ...(typed.Metadata ?? {}) } });
          throw preconditionFailed();
        }
        if (typed.IfNoneMatch === '*' && this.objects.has(typed.Key)) throw preconditionFailed();
        this.objects.set(typed.Key, { content, metadata: { ...(typed.Metadata ?? {}) } });
        for (const hook of this.afterStoreHooks) hook(op, typed.Key);
        return { ETag: '"fake-etag-not-a-checksum"' };
      }
      case 'CreateMultipartUploadCommand': {
        const typed = (command as { input: { Key: string; Metadata?: Record<string, string> } }).input;
        const uploadId = randomUUID();
        this.sessions.set(uploadId, { key: typed.Key, metadata: { ...(typed.Metadata ?? {}) } });
        return { UploadId: uploadId };
      }
      case 'AbortMultipartUploadCommand': {
        this.sessions.delete((command as { input: { UploadId: string } }).input.UploadId);
        return {};
      }
      case 'GetObjectCommand': {
        const object = this.objects.get(input.Key!);
        if (!object) throw notFound();
        if (input.IfMatch && input.IfMatch !== '"fake-etag"') throw preconditionFailed();
        return {
          ContentLength: object.content.length,
          Metadata: { ...object.metadata },
          Body: chunked(object.content, 64 * 1024),
        };
      }
      case 'ListObjectsV2Command':
        return { Contents: [] };
      default:
        throw new Error(`fake store does not implement ${op}`);
    }
  }

  ops(op: string) {
    return this.calls.filter((call) => call.op === op);
  }
}

// ---------------------------------------------------------------------------

describe.skipIf(!databaseUrl)('BR4 remote engine + R2 adapter (PostgreSQL + real age + fake R2)', () => {
  const admin = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  let sourceDb = '';
  let sourceUrl = '';
  let sourcePool: Pool | null = null;
  let repository: PostgresBackupRepository | null = null;
  let service: BackupService | null = null;
  let engineRoot: string;
  let tempRoot: string;
  let keyDir: string;
  let identityPath = '';
  let ageBin = '';
  let clock = Date.parse('2026-08-23T12:00:00Z');
  let adminActor: { id: string; organizationId: string };
  let runCount = 0;

  const actorOf = () => ({
    id: adminActor.id,
    organizationId: adminActor.organizationId,
    name: 'BR4 Admin',
    email: 'br4-admin@test.local',
    role: 'ADMIN' as const,
    mustChangePassword: false,
    isActive: true,
    version: 1,
  });

  const createRun = async (scope: 'DATABASE' | 'FULL_DATA' = 'DATABASE') => {
    runCount += 1;
    const created = await service!.requestManualBackup(actorOf(), {
      clientActionId: `br4-${runCount}-${randomUUID().slice(0, 8)}`,
      scope,
    });
    return created.id as string;
  };

  const buildBackupEngine = (filesRoot: string | null) =>
    new LocalBackupEngine({
      repository: repository!,
      service: service!,
      pool: sourcePool!,
      databaseUrl: sourceUrl,
      tempRoot,
      filesRoot,
      now: () => new Date((clock += 1_000)),
      application: { applicationVersion: 'test-0.1.0', gitCommit: 'c'.repeat(40) },
    });

  const buildEncryptor = () =>
    new LocalEncryptionEngine({ repository: repository!, service: service!, tempRoot, recipient: recipientValue });

  let recipientValue = '';

  const pipeline = async (filesRoot: string | null = null) => {
    const runId = await createRun(filesRoot ? 'FULL_DATA' : 'DATABASE');
    const pack = await buildBackupEngine(filesRoot).buildLocalBackup(runId);
    if (pack.outcome !== 'packaged') throw new Error(`BR2 failed: ${pack.failureCode}`);
    const encrypted = await buildEncryptor().encryptLocalBackup(runId);
    if (encrypted.outcome !== 'encrypted') throw new Error(`BR3 failed: ${encrypted.failureCode}`);
    return {
      runId,
      encryptedPath: encrypted.encryptedPath,
      localCiphertextSha256: encrypted.localCiphertextSha256,
      ciphertextPath: encrypted.encryptedPath,
      ciphertextSha256: encrypted.localCiphertextSha256,
      ciphertextBytes: encrypted.ciphertextBytes,
    };
  };

  const buildRemote = (store: FakeR2Store, maxAtomicPutBytes?: number) =>
    new RemoteBackupEngine({
      repository: repository!,
      service: service!,
      tempRoot,
      instanceId: INSTANCE_ID,
      storage: new CloudflareR2Storage({
        config: { accountId: 'a'.repeat(32), accessKeyId: 'test-key', secretAccessKey: 'test-secret', bucket: 'servora-test-bucket' },
        client: store,
      }),
      ...(maxAtomicPutBytes === undefined ? {} : { maxAtomicPutBytes }),
    });

  const canonicalKey = (runId: string, retentionClass: string) =>
    `production/${INSTANCE_ID}/v1/${retentionClass}/${runId}.sbk.age`;

  // Successful runs stay RUNNING (@CLEANUP) and hold the single-active slot;
  // release it after assertions (BR5 would promptly finish the run).
  const releaseSlot = async (runId: string) => {
    await service!.markCancelled(runId);
  };

  beforeAll(async () => {
    if (!admin) return;
    engineRoot = await mkdtemp(path.join(tmpdir(), 'servora-br4-'));
    tempRoot = path.join(engineRoot, 'workspaces');

    ageBin = resolveTool('AGE_BIN', 'age');
    const keygenBin = resolveTool('AGE_KEYGEN_BIN', 'age-keygen');
    const version = await promisifiedExecFile(ageBin, ['--version']);
    const parsed = /(\d+)\.(\d+)/.exec(version.stdout.trim());
    if (!parsed || !ageVersionSupported({ major: Number(parsed[1]), minor: Number(parsed[2]) })) {
      throw new Error('BR4 integration tests require the official age CLI >= 1.3.0');
    }
    keyDir = await mkdtemp(path.join(engineRoot, 'keys-'));
    await chmod(keyDir, 0o700);
    identityPath = path.join(keyDir, 'identity.txt');
    await promisifiedExecFile(keygenBin, ['-pq', '-o', identityPath]);
    await chmod(identityPath, 0o600);
    recipientValue = (await promisifiedExecFile(keygenBin, ['-y', identityPath])).stdout.trim();

    sourceDb = `servora_br4_src_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await admin.query(`CREATE DATABASE ${sourceDb}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${sourceDb}`;
    sourceUrl = url.toString();
    sourcePool = new Pool({ connectionString: sourceUrl });
    await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(sourcePool) });

    const org = (await sourcePool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone) VALUES ('BR4 Fixture Org', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!;
    const adminUser = (await sourcePool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'BR4 Admin', $2, 'hash', 'ADMIN') RETURNING id`,
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

  it('BR2→BR3→BR4 acceptance: exact bytes, metadata, state stops at CLEANUP', async () => {
    const store = new FakeR2Store();
    const artifact = await pipeline();
    const key = canonicalKey(artifact.runId, 'manual');
    const result = await buildRemote(store).uploadAndVerifyRemoteBackup(artifact);

    expect(result.outcome).toBe('verified');
    if (result.outcome !== 'verified') return;
    expect(result.remoteKey).toBe(key);
    expect(result.sha256).toBe(artifact.ciphertextSha256);
    expect(result.sizeBytes).toBe(artifact.ciphertextBytes);

    const run = await repository!.findRunById(artifact.runId);
    expect(run).toMatchObject({
      status: 'RUNNING',
      phase: 'CLEANUP',
      remoteKey: key,
      sizeBytes: artifact.ciphertextBytes,
      sha256: artifact.ciphertextSha256,
      verifiedAt: null,
      warningCode: null,
      failureCode: null,
    });

    const stored = store.objects.get(key)!;
    expect(Buffer.compare(stored.content, await readFile(artifact.ciphertextPath))).toBe(0);
    expect(stored.metadata).toEqual({
      'servora-backup-id': artifact.runId,
      'servora-format': '1',
      'servora-sha256': artifact.ciphertextSha256,
    });
    expect(store.ops('PutObjectCommand').at(-1)!.key).toBe(key);

    // Local artifacts (plaintext package AND ciphertext) are preserved.
    expect(await stat(artifact.ciphertextPath).then(() => true, () => false)).toBe(true);
    expect(await stat(path.join(tempRoot, artifact.runId, 'package', `${artifact.runId}.sbk.tar`))
      .then(() => true, () => false)).toBe(true);
    await releaseSlot(artifact.runId);
  });

  it('BR5 worker composes the accepted engines through SUCCESS and local cleanup', async () => {
    const store = new FakeR2Store();
    const runId = await createRun();
    const storage = new CloudflareR2Storage({
      config: {
        accountId: 'a'.repeat(32),
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
        bucket: 'servora-test-bucket',
      },
      client: store,
    });
    const worker = new BackupWorker({
      repository: repository!,
      service: service!,
      enabled: true,
      now: () => new Date((clock += 1_000)),
      sleep: async () => undefined,
      executeRun: createBackupPipelineExecutor({
        repository: repository!,
        pool: sourcePool!,
        service: service!,
        databaseUrl: sourceUrl,
        tempRoot,
        filesRoot: null,
        recipient: recipientValue,
        storage,
        instanceId: INSTANCE_ID,
        application: { applicationVersion: 'br5-test-0.1.0', gitCommit: 'b'.repeat(40) },
      }),
    });

    try {
      await expect(worker.runOnce()).resolves.toEqual({ kind: 'claimed', runId });
      const run = await repository!.findRunById(runId);
      expect(run).toMatchObject({
        status: 'SUCCESS',
        phase: 'CLEANUP',
        remoteKey: expect.any(String),
        sizeBytes: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        verifiedAt: expect.any(Date),
        warningCode: null,
        failureCode: null,
      });
      expect(store.objects.size).toBe(1);
      expect(await stat(path.join(tempRoot, runId)).then(() => true, () => false)).toBe(false);
    } finally {
      storage.destroy();
    }
  });

  it('adapter passes unprefixed Metadata + binary content type + If-None-Match on the wire form', async () => {
    const store = new FakeR2Store();
    let capturedPut: { metadata?: Record<string, string>; contentType?: string; ifNoneMatch?: string; bodyIsStream: boolean } | null = null;
    const original = store.send.bind(store);
    store.send = async (command: unknown) => {
      const op = (command as { constructor: { name: string } }).constructor.name;
      if (op === 'PutObjectCommand') {
        const input = (command as { input: { Metadata?: Record<string, string>; ContentType?: string; IfNoneMatch?: string; Body?: unknown } }).input;
        capturedPut = {
          metadata: input.Metadata,
          contentType: input.ContentType,
          ifNoneMatch: input.IfNoneMatch,
          bodyIsStream: !!(input.Body && typeof (input.Body as Readable).pipe === 'function'),
        };
      }
      return original(command);
    };
    const artifact = await pipeline();
    await buildRemote(store).uploadAndVerifyRemoteBackup(artifact);
    expect(capturedPut).not.toBeNull();
    expect(capturedPut!.metadata).toEqual({
      'servora-backup-id': artifact.runId,
      'servora-format': '1',
      'servora-sha256': artifact.ciphertextSha256,
    });
    expect(Object.keys(capturedPut!.metadata!).every((name) => !name.startsWith('x-amz-meta-'))).toBe(true);
    expect(capturedPut!.contentType).toBe('application/octet-stream');
    expect(capturedPut!.ifNoneMatch).toBe('*');
    expect(capturedPut!.bodyIsStream).toBe(true);
    await releaseSlot(artifact.runId);
  });

  it('pre-existing IDENTICAL object is idempotently accepted without a new upload', async () => {
    const store = new FakeR2Store();
    const artifact = await pipeline();
    const key = canonicalKey(artifact.runId, 'manual');
    store.objects.set(key, {
      content: await readFile(artifact.ciphertextPath),
      metadata: {
        'servora-backup-id': artifact.runId,
        'servora-format': '1',
        'servora-sha256': artifact.ciphertextSha256,
      },
    });

    const result = await buildRemote(store).uploadAndVerifyRemoteBackup(artifact);
    expect(result.outcome).toBe('verified');
    expect(store.ops('PutObjectCommand')).toHaveLength(0);
    expect((await repository!.findRunById(artifact.runId))?.phase).toBe('CLEANUP');
    await releaseSlot(artifact.runId);
  });

  it('pre-existing DIFFERING metadata fails closed as R2_OBJECT_CONFLICT (no overwrite/delete)', async () => {
    const store = new FakeR2Store();
    const artifact = await pipeline();
    const key = canonicalKey(artifact.runId, 'manual');
    const originalContent = Buffer.concat([await readFile(artifact.ciphertextPath)]);
    store.objects.set(key, {
      content: originalContent,
      metadata: {
        'servora-backup-id': artifact.runId,
        'servora-format': '1',
        'servora-sha256': '0'.repeat(64),
      },
    });

    const result = await buildRemote(store).uploadAndVerifyRemoteBackup(artifact);
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'R2_OBJECT_CONFLICT', retryable: false });
    const run = await repository!.findRunById(artifact.runId);
    expect(run).toMatchObject({ status: 'FAILED', failureCode: 'R2_OBJECT_CONFLICT', sha256: null, remoteKey: null, verifiedAt: null });
    expect(store.ops('PutObjectCommand')).toHaveLength(0);
    expect(store.ops('DeleteObjectCommand')).toHaveLength(0);
    expect(store.objects.get(key)!.content.equals(originalContent)).toBe(true);
    // Local workspace is preserved for operator/BR5 investigation.
    const ciphertextStat = await readFile(artifact.ciphertextPath).then(() => true, () => false);
    expect(ciphertextStat).toBe(true);
  });

  it.each([
    ['metadata checksum differs', (store: FakeR2Store, _key: string, sha: string, id: string) => {
      store.afterStoreHooks.push((op, key) => {
        if (op === 'PutObjectCommand') store.objects.get(key)!.metadata['servora-sha256'] = 'f'.repeat(64);
        void sha; void id;
      });
    }],
    ['metadata backup id differs', (store: FakeR2Store, _key: string, _sha: string, _id: string) => {
      store.afterStoreHooks.push((op, key) => {
        if (op === 'PutObjectCommand') store.objects.get(key)!.metadata['servora-backup-id'] = randomUUID();
      });
    }],
    ['metadata format differs', (store: FakeR2Store, _key: string, _sha: string, _id: string) => {
      store.afterStoreHooks.push((op, key) => {
        if (op === 'PutObjectCommand') store.objects.get(key)!.metadata['servora-format'] = '2';
      });
    }],
    ['metadata absent', (store: FakeR2Store) => {
      store.afterStoreHooks.push((op, key) => {
        if (op === 'PutObjectCommand') store.objects.get(key)!.metadata = {};
      });
    }],
    ['remote bytes tampered', (store: FakeR2Store) => {
      store.afterStoreHooks.push((op, key) => {
        if (op === 'PutObjectCommand') store.objects.get(key)!.content[0]! ^= 0xff;
      });
    }],
    ['remote bytes truncated', (store: FakeR2Store) => {
      store.afterStoreHooks.push((op, key) => {
        const object = store.objects.get(key)!;
        object.content = object.content.subarray(0, object.content.length - 1);
      });
    }],
  ])('fresh upload with %s fails closed as REMOTE_CHECKSUM_MISMATCH', async (_label, mutate) => {
    const store = new FakeR2Store();
    const artifact = await pipeline();
    mutate(store, canonicalKey(artifact.runId, 'manual'), artifact.ciphertextSha256, artifact.runId);

    const result = await buildRemote(store).uploadAndVerifyRemoteBackup(artifact);
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'REMOTE_CHECKSUM_MISMATCH', retryable: false });
    const run = await repository!.findRunById(artifact.runId);
    expect(run).toMatchObject({
      status: 'FAILED',
      failureCode: 'REMOTE_CHECKSUM_MISMATCH',
      sha256: null,
      remoteKey: null,
      sizeBytes: null,
      verifiedAt: null,
    });
    expect(run!.phase).not.toBe('CLEANUP');
    // The (corrupt) remote object is deliberately left in place.
    expect(store.objects.size).toBe(1);
  });

  it('412 race with an identical concurrent object resolves idempotently', async () => {
    const store = new FakeR2Store();
    store.raceMode = 'identical';
    const artifact = await pipeline();
    const result = await buildRemote(store).uploadAndVerifyRemoteBackup(artifact);
    expect(result.outcome).toBe('verified');
    if (result.outcome !== 'verified') return;
    expect(result.sha256).toBe(artifact.ciphertextSha256);
    expect((await repository!.findRunById(artifact.runId))?.phase).toBe('CLEANUP');
    await releaseSlot(artifact.runId);
  });

  it('412 race with a differing concurrent object fails closed as R2_OBJECT_CONFLICT', async () => {
    const store = new FakeR2Store();
    store.raceMode = 'corrupt';
    const artifact = await pipeline();
    const result = await buildRemote(store).uploadAndVerifyRemoteBackup(artifact);
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'R2_OBJECT_CONFLICT' });
    expect((await repository!.findRunById(artifact.runId))?.status).toBe('FAILED');
    // The raced object (stored by the "concurrent writer") is untouched.
    const key = canonicalKey(artifact.runId, 'manual');
    const stored = store.objects.get(key)!;
    const original = await readFile(artifact.ciphertextPath);
    expect(stored.content.length).toBe(original.length);
    expect(stored.content.equals(original)).toBe(false);
  });

  it('upload transport failure is retryable: run stays RUNNING @ UPLOAD, not FAILED', async () => {
    const store = new FakeR2Store();
    store.failNext('PutObjectCommand', () => { throw transportError(); });
    const artifact = await pipeline();
    const remote = buildRemote(store);
    const result = await remote.uploadAndVerifyRemoteBackup(artifact);

    expect(result).toMatchObject({
      outcome: 'failed',
      failureCode: 'R2_UPLOAD_FAILED',
      retryable: true,
      phase: 'UPLOAD',
    });
    const run = await repository!.findRunById(artifact.runId);
    expect(run).toMatchObject({ status: 'RUNNING', phase: 'UPLOAD', failureCode: null, sha256: null });
    expect(store.objects.size).toBe(0);

    const retry = await remote.retryUploadRemoteBackup(artifact);
    expect(retry).toMatchObject({ outcome: 'verified', sha256: artifact.ciphertextSha256 });
    expect(await repository!.findRunById(artifact.runId)).toMatchObject({
      status: 'RUNNING',
      phase: 'CLEANUP',
      sha256: artifact.ciphertextSha256,
      verifiedAt: null,
    });
    await releaseSlot(artifact.runId);
  });

  it('pre-upload HEAD transport failure is retryable at UPLOAD phase', async () => {
    const store = new FakeR2Store();
    store.failNext('HeadObjectCommand', () => { throw transportError(); });
    const artifact = await pipeline();
    const result = await buildRemote(store).uploadAndVerifyRemoteBackup(artifact);
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'R2_UPLOAD_FAILED', retryable: true });
    expect(await repository!.findRunById(artifact.runId)).toMatchObject({ status: 'RUNNING', phase: 'UPLOAD' });
    await releaseSlot(artifact.runId);
  });

  it.each([
    ['HEAD', 'HeadObjectCommand', true],
    ['GET', 'GetObjectCommand', false],
  ] as const)('verify %s transport failure is retryable and same-phase re-entry succeeds', async (_label, operation, skipFirst) => {
    const store = new FakeR2Store();
    const artifact = await pipeline();
    if (skipFirst) store.failNext(operation, () => undefined);
    store.failNext(operation, () => { throw transportError(); });

    const first = await buildRemote(store).uploadAndVerifyRemoteBackup(artifact);
    expect(first).toMatchObject({
      outcome: 'failed',
      failureCode: 'R2_VERIFY_FAILED',
      retryable: true,
      phase: 'REMOTE_VERIFY',
    });
    expect(await repository!.findRunById(artifact.runId)).toMatchObject({
      status: 'RUNNING',
      phase: 'REMOTE_VERIFY',
      sha256: null,
      failureCode: null,
    });

    const second = await buildRemote(store).verifyRemoteBackup(artifact);
    expect(second.outcome).toBe('verified');
    const run = await repository!.findRunById(artifact.runId);
    expect(run).toMatchObject({
      status: 'RUNNING',
      phase: 'CLEANUP',
      remoteKey: canonicalKey(artifact.runId, 'manual'),
      sha256: artifact.ciphertextSha256,
      sizeBytes: artifact.ciphertextBytes,
      verifiedAt: null,
    });
    await releaseSlot(artifact.runId);
  });

  it('auth failure is terminal R2_AUTH_FAILED with safe summary', async () => {
    const store = new FakeR2Store();
    store.failNext('HeadObjectCommand', () => { throw authError(); });
    const artifact = await pipeline();
    const result = await buildRemote(store).uploadAndVerifyRemoteBackup(artifact);
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'R2_AUTH_FAILED', retryable: false });
    expect(result.outcome === 'failed' ? result.failureSummary : '').not.toMatch(/test-key|test-secret|credential|Authorization/i);
    expect(await repository!.findRunById(artifact.runId)).toMatchObject({
      status: 'FAILED',
      failureCode: 'R2_AUTH_FAILED',
      sha256: null,
    });
  });

  it('fails closed before upload when the artifact exceeds the approved atomic PUT limit', async () => {
    const store = new FakeR2Store();
    const artifact = await pipeline();
    const result = await buildRemote(store, artifact.ciphertextBytes - 1)
      .uploadAndVerifyRemoteBackup(artifact);

    expect(result).toMatchObject({
      outcome: 'failed',
      failureCode: 'R2_OBJECT_TOO_LARGE',
      retryable: false,
      phase: 'UPLOAD',
    });
    expect(store.ops('PutObjectCommand')).toHaveLength(0);
    expect(store.ops('CreateMultipartUploadCommand')).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
    expect(store.objects.size).toBe(0);
    expect(await repository!.findRunById(artifact.runId)).toMatchObject({
      status: 'FAILED',
      phase: 'UPLOAD',
      failureCode: 'R2_OBJECT_TOO_LARGE',
      remoteKey: null,
      sha256: null,
      verifiedAt: null,
    });
  });

  it('rejects local ciphertext mutation against the exact BR3 handoff before remote access', async () => {
    const store = new FakeR2Store();
    const artifact = await pipeline();
    const mutated = await readFile(artifact.ciphertextPath);
    mutated[0]! ^= 0xff;
    await writeFile(artifact.ciphertextPath, mutated);

    await expect(buildRemote(store).uploadAndVerifyRemoteBackup(artifact))
      .rejects.toThrow(/hash differs from BR3 handoff/);
    expect(store.calls).toHaveLength(0);
    expect(await repository!.findRunById(artifact.runId)).toMatchObject({
      status: 'RUNNING', phase: 'ENCRYPT', failureCode: null, remoteKey: null, sha256: null,
    });
    await releaseSlot(artifact.runId);
  });

  it('rejects a symlink substituted for the canonical ciphertext before remote access', async () => {
    const store = new FakeR2Store();
    const artifact = await pipeline();
    const movedArtifact = `${artifact.ciphertextPath}.target`;
    await rename(artifact.ciphertextPath, movedArtifact);
    await symlink(movedArtifact, artifact.ciphertextPath);

    await expect(buildRemote(store).uploadAndVerifyRemoteBackup(artifact))
      .rejects.toThrow(/regular encrypted artifact missing/);
    expect(store.calls).toHaveLength(0);
    expect(await repository!.findRunById(artifact.runId)).toMatchObject({
      status: 'RUNNING', phase: 'ENCRYPT', failureCode: null, remoteKey: null, sha256: null,
    });
    await releaseSlot(artifact.runId);
  });

  it('engine guards: wrong phase rejected; missing artifact preserved for BR5', async () => {
    const store = new FakeR2Store();
    const queuedRun = await createRun();
    const queuedHandoff = {
      runId: queuedRun,
      encryptedPath: '',
      ciphertextBytes: 1,
      localCiphertextSha256: '0'.repeat(64),
    };
    await expect(buildRemote(store).uploadAndVerifyRemoteBackup(queuedHandoff)).rejects.toThrow(/ENCRYPT/);
    await expect(buildRemote(store).retryUploadRemoteBackup(queuedHandoff)).rejects.toThrow(/UPLOAD/);
    await expect(buildRemote(store).verifyRemoteBackup(queuedHandoff)).rejects.toThrow(/REMOTE_VERIFY/);
    await service!.markCancelled(queuedRun);

    const artifact = await pipeline();
    await rm(artifact.ciphertextPath);
    await expect(buildRemote(store).uploadAndVerifyRemoteBackup(artifact)).rejects.toThrow(/missing/);
    expect(await repository!.findRunById(artifact.runId)).toMatchObject({ status: 'RUNNING', phase: 'ENCRYPT', failureCode: null });
    await service!.markCancelled(artifact.runId);
  });

  it('internal reverify primitive: pass on intact object, fail closed on tamper, rows untouched', async () => {
    const store = new FakeR2Store();
    const artifact = await pipeline();
    await buildRemote(store).uploadAndVerifyRemoteBackup(artifact);
    const key = canonicalKey(artifact.runId, 'manual');

    const pass = await buildRemote(store).reverify(artifact.runId);
    expect(pass).toMatchObject({ outcome: 'pass', remoteKey: key, sha256: artifact.ciphertextSha256 });

    store.objects.get(key)!.content[0]! ^= 0xff;
    const failed = await buildRemote(store).reverify(artifact.runId);
    expect(failed).toMatchObject({ outcome: 'failed', failureCode: 'REMOTE_CHECKSUM_MISMATCH' });
    // Row untouched by a failed reverify (still RUNNING @ CLEANUP, evidence intact).
    expect(await repository!.findRunById(artifact.runId)).toMatchObject({
      status: 'RUNNING',
      phase: 'CLEANUP',
      sha256: artifact.ciphertextSha256,
      verifiedAt: null,
    });

    // Terminal SUCCESS rows are never mutated by reverify outcomes.
    await service!.completeRun(artifact.runId);
    const successRun = await repository!.findRunById(artifact.runId);
    expect(successRun).toMatchObject({ status: 'SUCCESS', verifiedAt: expect.any(Date) });
    store.objects.get(key)!.content[store.objects.get(key)!.content.length - 1]! ^= 0xff;
    const failedAgain = await buildRemote(store).reverify(artifact.runId);
    expect(failedAgain).toMatchObject({ outcome: 'failed' });
    const afterFail = await repository!.findRunById(artifact.runId);
    expect(afterFail!.status).toBe('SUCCESS');
    expect(afterFail!.verifiedAt!.toISOString()).toBe(successRun!.verifiedAt!.toISOString());
  });

  it('connection test probe: list + create + abort, no object, safe classification', async () => {
    const store = new FakeR2Store();
    const storage = new CloudflareR2Storage({
      config: { accountId: 'a'.repeat(32), accessKeyId: 'test-key', secretAccessKey: 'test-secret', bucket: 'servora-test-bucket' },
      client: store,
    });
    const probeKey = buildConnectionTestKey(INSTANCE_ID, randomUUID());

    const ok = await storage.testConnection(probeKey);
    expect(ok).toEqual({ ok: true });
    expect(store.calls.map((call) => call.op)).toEqual([
      'ListObjectsV2Command', 'CreateMultipartUploadCommand', 'AbortMultipartUploadCommand',
    ]);
    expect(store.objects.size).toBe(0);
    expect(store.sessions.size).toBe(0);

    const authStore = new FakeR2Store();
    authStore.failNext('ListObjectsV2Command', () => { throw authError(); });
    const authProbe = await new CloudflareR2Storage({
      config: { accountId: 'a'.repeat(32), accessKeyId: 'k', secretAccessKey: 's', bucket: 'test-bucket' },
      client: authStore,
    }).testConnection(probeKey);
    expect(authProbe).toEqual({ ok: false, errorClass: 'AUTH' });

    const transportStore = new FakeR2Store();
    transportStore.failNext('CreateMultipartUploadCommand', () => { throw transportError(); });
    const transportProbe = await new CloudflareR2Storage({
      config: { accountId: 'a'.repeat(32), accessKeyId: 'k', secretAccessKey: 's', bucket: 'test-bucket' },
      client: transportStore,
    }).testConnection(probeKey);
    expect(transportProbe).toEqual({ ok: false, errorClass: 'TRANSPORT' });

    const abortFailStore = new FakeR2Store();
    abortFailStore.failNext('AbortMultipartUploadCommand', () => { throw transportError(); });
    const abortFail = await new CloudflareR2Storage({
      config: { accountId: 'a'.repeat(32), accessKeyId: 'k', secretAccessKey: 's', bucket: 'test-bucket' },
      client: abortFailStore,
    }).testConnection(probeKey);
    // Abort failure is NOT a clean success.
    expect(abortFail).toEqual({ ok: false, errorClass: 'TRANSPORT' });
  });
});
