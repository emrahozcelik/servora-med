import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';

import { hashFile } from '../engine.js';
import {
  PostgresBackupRepository,
  type BackupRepository,
  type CreateRestoreRunInput,
  type UpdateRestoreRunInput,
} from '../repository.js';
import {
  extractPackageMember,
  inspectPackageArchive,
  parseChecksumSidecar,
} from './archive.js';
import { decryptAgeArchive, resolveOperatorIdentity } from './decrypt.js';
import { withTargetRestoreAdvisoryLock } from './locking.js';
import { parseRestoreManifest, type RestoreManifestV1 } from './manifest.js';
import {
  inspectPgDumpArchive,
  maintenanceDatabaseUrl,
  restoreDumpIntoNewDatabase,
  type NewTargetRestoreResult,
  validateRestoredDatabase,
} from './postgres.js';
import {
  downloadAndVerifyRemote,
  resolveRemoteBackup,
  type RemoteBackupDescriptor,
  type RestoreRemoteStore,
} from './remote.js';
import { createRestoreWorkspace, removeRestoreWorkspace, type RestoreWorkspace } from './workspace.js';
import type { RestoreMode } from '../types.js';
import { restoreFullDataArchive } from './files.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_RESTORE_COMPONENT_BYTES = 5_363_466_240;

export class RestoreOperationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'RESTORE_MANIFEST_INVALID'
      | 'RESTORE_FORMAT_UNSUPPORTED'
      | 'RESTORE_CHECKSUM_FAILED'
      | 'RESTORE_DATABASE_CREATE_FAILED'
      | 'RESTORE_PG_RESTORE_FAILED'
      | 'RESTORE_INTEGRITY_FAILED' = 'RESTORE_INTEGRITY_FAILED',
  ) {
    super(message);
    this.name = 'RestoreOperationError';
  }
}

export type RestoreServiceOptions = {
  storage?: RestoreRemoteStore;
  instanceId?: string;
  targetAdminDatabaseUrl?: string;
  controlDatabaseUrl?: string;
  productionDatabaseUrl?: string | null;
  identityPath?: string;
  workspaceRoot?: string;
  filesRoot?: string | null;
  evidenceDirectory?: string;
  initiatedBy?: string;
  signal?: AbortSignal;
};

type PreparedPackage = {
  workspace: RestoreWorkspace;
  descriptor: RemoteBackupDescriptor | null;
  manifest: RestoreManifestV1;
  componentEvidence: {
    database: { bytes: number; sha256: string };
    files: { bytes: number; sha256: string } | null;
  };
  ciphertextBytes: number | null;
  ciphertextSha256: string | null;
};

type SafeRestoreEvidence = {
  backupId: string;
  remoteKey: string | null;
  scope: RestoreManifestV1['backupScope'];
  schemaVersion: string;
  pgRestoreVersion: string;
  databaseBytes: number;
  filesBytes: number | null;
  users: number;
  jobCards: number;
  orphanJobCards: number;
  nonTerminalBackupRuns: number;
  activeRestoreRuns: number;
  workerStateRows: number;
  fullDataRestored: boolean;
};

export class RestoreCancelledError extends Error {
  constructor() {
    super('restore cancelled');
    this.name = 'RestoreCancelledError';
  }
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RestoreCancelledError();
}

function mapRestoreError(error: unknown): RestoreOperationError {
  if (error instanceof RestoreOperationError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'RESTORE_FORMAT_UNSUPPORTED') return new RestoreOperationError('restore format is unsupported', code);
  if (code === 'RESTORE_CHECKSUM_FAILED' || code === 'REMOTE_CHECKSUM_MISMATCH') {
    return new RestoreOperationError('restore checksum verification failed', 'RESTORE_CHECKSUM_FAILED');
  }
  if (code === 'RESTORE_DATABASE_CREATE_FAILED') return new RestoreOperationError('target database could not be created', code);
  if (code === 'RESTORE_PG_RESTORE_FAILED') return new RestoreOperationError('pg_restore failed', code);
  if (code === 'RESTORE_INTEGRITY_FAILED') return new RestoreOperationError('restored database integrity validation failed', code);
  return new RestoreOperationError('restore operation failed');
}

function persistedFailureCode(error: unknown): UpdateRestoreRunInput['failureCode'] {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'RESTORE_FORMAT_UNSUPPORTED') return 'RESTORE_FORMAT_UNSUPPORTED';
  if (code === 'RESTORE_CHECKSUM_FAILED' || code === 'REMOTE_CHECKSUM_MISMATCH') return 'RESTORE_CHECKSUM_FAILED';
  if (code === 'RESTORE_DATABASE_CREATE_FAILED') return 'RESTORE_DATABASE_CREATE_FAILED';
  if (code === 'RESTORE_PG_RESTORE_FAILED') return 'RESTORE_PG_RESTORE_FAILED';
  if (code === 'RESTORE_MANIFEST_INVALID') return 'RESTORE_MANIFEST_INVALID';
  return 'RESTORE_INTEGRITY_FAILED';
}

function safeManifestProjection(manifest: RestoreManifestV1) {
  return {
    backupId: manifest.backupId,
    createdAt: manifest.createdAt,
    applicationVersion: manifest.application.applicationVersion,
    backupScope: manifest.backupScope,
    origin: manifest.origin,
    retentionClass: manifest.retentionClass,
    schemaVersion: manifest.database.schemaVersion,
    databaseServerVersion: manifest.database.serverVersion,
    dumpVersion: manifest.database.dumpVersion,
    dumpToolVersion: manifest.database.dumpToolVersion,
    databaseBytes: manifest.contents.database.bytes,
    filesBytes: manifest.contents.files?.bytes ?? null,
  };
}

export class RestoreService {
  constructor(private readonly options: RestoreServiceOptions) {}

  async listRemote(): Promise<{ items: RemoteBackupDescriptor[]; pages: number }> {
    if (!this.options.storage || !this.options.instanceId) throw new RestoreOperationError('R2 storage and instance id are required');
    const { listRemoteBackups } = await import('./remote.js');
    return listRemoteBackups(this.options.storage, this.options.instanceId);
  }

  async inspect(input: { archiveOrId: string; remote?: boolean; expectedSha256?: string }) {
    const prepared = await this.preparePackage(input);
    try {
      return {
        outcome: 'INSPECTED' as const,
        remoteKey: prepared.descriptor?.key ?? null,
        ciphertextBytes: prepared.ciphertextBytes,
        ciphertextSha256: prepared.ciphertextSha256,
        ...safeManifestProjection(prepared.manifest),
      };
    } finally {
      await removeRestoreWorkspace(prepared.workspace.root).catch(() => undefined);
    }
  }

  async verify(input: { archiveOrId: string; remote?: boolean; expectedSha256?: string }) {
    const prepared = await this.preparePackage(input);
    try {
      checkSignal(this.options.signal);
      const pgRestoreVersion = await inspectPgDumpArchive({
        dumpPath: prepared.workspace.databaseDumpPath,
        sourceServerVersion: prepared.manifest.database.serverVersion,
        databaseUrlForEnv: this.options.targetAdminDatabaseUrl,
        signal: this.options.signal,
      });
      return {
        outcome: 'VERIFIED' as const,
        pgRestoreVersion: pgRestoreVersion.raw,
        ...safeManifestProjection(prepared.manifest),
        remoteKey: prepared.descriptor?.key ?? null,
        ciphertextBytes: prepared.ciphertextBytes,
        ciphertextSha256: prepared.ciphertextSha256,
      };
    } finally {
      await removeRestoreWorkspace(prepared.workspace.root).catch(() => undefined);
    }
  }

  async restore(input: {
    archiveOrId: string;
    mode: RestoreMode;
    targetDatabase: string;
    acknowledgeDestructiveRestore: boolean;
    expectedSha256?: string;
    targetFilesRoot?: string;
    keepFailedTarget?: boolean;
  }) {
    if (!input.acknowledgeDestructiveRestore) throw new RestoreOperationError('destructive restore acknowledgement is required');
    if (!this.options.targetAdminDatabaseUrl) throw new RestoreOperationError('RESTORE_TARGET_DATABASE_URL is required');
    if (input.mode === 'REHEARSAL' && !this.options.controlDatabaseUrl) {
      throw new RestoreOperationError('REHEARSAL requires RESTORE_CONTROL_DATABASE_URL');
    }
    if (input.mode === 'REHEARSAL') {
      const controlPool = new Pool({ connectionString: this.options.controlDatabaseUrl!, max: 1, connectionTimeoutMillis: 5_000 });
      try {
        const repository = new PostgresBackupRepository(controlPool);
        const locked = await repository.tryWithBackupExclusionLock(
          () => this.executeRestore(input, repository),
        );
        if (locked === null) throw new RestoreOperationError('another backup or restore already owns the shared lock');
        return locked;
      } finally {
        await controlPool.end();
      }
    }
    const targetPool = new Pool({ connectionString: maintenanceDatabaseUrl(this.options.targetAdminDatabaseUrl), max: 1, connectionTimeoutMillis: 5_000 });
    try {
      const locked = await withTargetRestoreAdvisoryLock(targetPool, () => this.executeRestore(input, null));
      if (!locked.acquired) throw new RestoreOperationError('another backup or restore already owns the shared lock');
      return locked.value;
    } finally {
      await targetPool.end();
    }
  }

  private async preparePackage(input: { archiveOrId: string; remote?: boolean; expectedSha256?: string }): Promise<PreparedPackage> {
    checkSignal(this.options.signal);
    const isRemote = input.remote ?? (UUID.test(input.archiveOrId) && !path.isAbsolute(input.archiveOrId));
    const workspace = await createRestoreWorkspace({
      root: this.options.workspaceRoot,
      forbiddenRoots: [process.cwd(), ...(this.options.filesRoot ? [this.options.filesRoot] : [])],
    });
    try {
      let descriptor: RemoteBackupDescriptor | null = null;
      let ciphertextBytes: number | null = null;
      let ciphertextSha256: string | null = null;
      if (isRemote) {
        if (!this.options.storage || !this.options.instanceId) throw new RestoreOperationError('R2 storage and instance id are required');
        descriptor = await resolveRemoteBackup(this.options.storage, this.options.instanceId, input.archiveOrId);
        const remote = await downloadAndVerifyRemote(
          this.options.storage,
          descriptor,
          workspace.ciphertextPath,
          this.options.signal,
        );
        ciphertextBytes = remote.contentLength;
        ciphertextSha256 = remote.sha256;
        await decryptAgeArchive({
          ciphertextPath: workspace.ciphertextPath,
          plaintextPath: workspace.plaintextPath,
          identityPath: resolveOperatorIdentity({ identityPath: this.options.identityPath }),
          signal: this.options.signal,
        });
      } else {
        const source = await stat(input.archiveOrId).catch(() => null);
        if (!source?.isFile()) throw new RestoreOperationError('local archive path is unavailable', 'RESTORE_CHECKSUM_FAILED');
        if (input.archiveOrId.endsWith('.tar')) {
          await copyFile(input.archiveOrId, workspace.plaintextPath);
        } else {
          await copyFile(input.archiveOrId, workspace.ciphertextPath);
          ciphertextBytes = source.size;
          ciphertextSha256 = await hashFile(input.archiveOrId);
          if (!input.expectedSha256 || input.expectedSha256 !== ciphertextSha256) {
            throw new RestoreOperationError('local ciphertext requires a matching --expected-sha256', 'RESTORE_CHECKSUM_FAILED');
          }
          await decryptAgeArchive({
            ciphertextPath: workspace.ciphertextPath,
            plaintextPath: workspace.plaintextPath,
            identityPath: resolveOperatorIdentity({ identityPath: this.options.identityPath }),
            signal: this.options.signal,
          });
        }
      }

      const archive = await inspectPackageArchive(workspace.plaintextPath, undefined, this.options.signal);
      // Materialize metadata first. Component extraction happens only after
      // the manifest has fixed the allowlist and size/checksum expectations.
      await extractPackageMember(workspace.plaintextPath, 'manifest.json', workspace.manifestPath, undefined, this.options.signal);
      const manifestRaw = JSON.parse(await readFile(workspace.manifestPath, 'utf8')) as unknown;
      const manifest = parseRestoreManifest(manifestRaw);
      if (descriptor && manifest.backupId !== descriptor.backupId) {
        throw new RestoreOperationError('manifest backup id does not match the remote object', 'RESTORE_MANIFEST_INVALID');
      }
      const filesExpected = manifest.contents.files !== null;
      if (archive.members.includes('files.tar.zst') !== filesExpected) {
        throw new RestoreOperationError('files archive presence does not match the manifest', 'RESTORE_MANIFEST_INVALID');
      }
      await extractPackageMember(workspace.plaintextPath, 'checksums.sha256', workspace.checksumPath, undefined, this.options.signal);
      const sidecar = parseChecksumSidecar(await readFile(workspace.checksumPath, 'utf8'), filesExpected);
      await extractPackageMember(
        workspace.plaintextPath,
        'database.dump',
        workspace.databaseDumpPath,
        undefined,
        this.options.signal,
        manifest.contents.database.bytes,
      );
      if (filesExpected) {
        await extractPackageMember(
          workspace.plaintextPath,
          'files.tar.zst',
          workspace.filesArchivePath,
          undefined,
          this.options.signal,
          manifest.contents.files!.bytes,
        );
      }
      const componentEvidence = {
        database: await verifyComponent(workspace.databaseDumpPath, manifest.contents.database, sidecar['database.dump']!),
        files: manifest.contents.files
          ? await verifyComponent(workspace.filesArchivePath, manifest.contents.files, sidecar['files.tar.zst']!)
          : null,
      };
      return { workspace, descriptor, manifest, componentEvidence, ciphertextBytes, ciphertextSha256 };
    } catch (error) {
      await removeRestoreWorkspace(workspace.root).catch(() => undefined);
      if (this.options.signal?.aborted) throw new RestoreCancelledError();
      throw mapRestoreError(error);
    }
  }

  private async executeRestore(
    input: {
      archiveOrId: string;
      mode: RestoreMode;
      targetDatabase: string;
      acknowledgeDestructiveRestore: boolean;
      expectedSha256?: string;
      targetFilesRoot?: string;
      keepFailedTarget?: boolean;
    },
    repository: BackupRepository | null,
  ) {
    const runId = randomUUID();
    let prepared: PreparedPackage | null = null;
    let target: NewTargetRestoreResult | null = null;
    let restoreRunCreated = false;
    try {
      if (repository) {
        const createInput: CreateRestoreRunInput = {
          id: runId,
          backupId: UUID.test(input.archiveOrId) ? input.archiveOrId.toLowerCase() : null,
          mode: input.mode,
          initiatedBy: this.options.initiatedBy ?? 'operator-cli',
          targetDatabase: input.targetDatabase,
          preRestoreBackupId: null,
        };
        await repository.createRestoreRun(createInput);
        restoreRunCreated = true;
      }
      prepared = await this.preparePackage(input);
      checkSignal(this.options.signal);
      const pgRestoreVersion = await inspectPgDumpArchive({
        dumpPath: prepared.workspace.databaseDumpPath,
        sourceServerVersion: prepared.manifest.database.serverVersion,
        databaseUrlForEnv: this.options.targetAdminDatabaseUrl,
        signal: this.options.signal,
      });
      target = await restoreDumpIntoNewDatabase({
        adminDatabaseUrl: this.options.targetAdminDatabaseUrl!,
        targetDatabase: input.targetDatabase,
        dumpPath: prepared.workspace.databaseDumpPath,
        manifest: prepared.manifest,
        productionDatabaseUrl: this.options.productionDatabaseUrl,
        keepFailedTarget: input.keepFailedTarget,
        signal: this.options.signal,
      });
      checkSignal(this.options.signal);
      const databaseEvidence = await validateRestoredDatabase(target.targetDatabaseUrl, prepared.manifest);
      const fullDataRestored = prepared.manifest.contents.files !== null;
      if (fullDataRestored) {
        if (!input.targetFilesRoot) throw new RestoreOperationError('FULL_DATA restore requires a new --target-files-root', 'RESTORE_INTEGRITY_FAILED');
        await restoreFullDataArchive(
          prepared.workspace.filesArchivePath,
          input.targetFilesRoot,
          prepared.workspace.root,
          this.options.signal,
          this.options.filesRoot ? [this.options.filesRoot] : [],
        );
      }
      const evidence: SafeRestoreEvidence = {
        backupId: prepared.manifest.backupId,
        remoteKey: prepared.descriptor?.key ?? null,
        scope: prepared.manifest.backupScope,
        schemaVersion: prepared.manifest.database.schemaVersion,
        pgRestoreVersion: pgRestoreVersion.raw,
        databaseBytes: prepared.componentEvidence.database.bytes,
        filesBytes: prepared.componentEvidence.files?.bytes ?? null,
        users: databaseEvidence.users,
        jobCards: databaseEvidence.jobCards,
        orphanJobCards: databaseEvidence.orphanJobCards,
        nonTerminalBackupRuns: databaseEvidence.nonTerminalBackupRuns,
        activeRestoreRuns: databaseEvidence.activeRestoreRuns,
        workerStateRows: databaseEvidence.workerStateRows,
        fullDataRestored,
      };
      if (repository && restoreRunCreated && repository.updateRestoreRun) {
        await repository.updateRestoreRun(runId, {
          status: 'READY_FOR_CUTOVER',
          completedAt: null,
          verificationResult: evidence,
          failureCode: null,
        });
      } else {
        await persistDisasterRecoveryEvidence(target.targetDatabaseUrl, runId, input.targetDatabase, evidence, this.options.evidenceDirectory);
      }
      return {
        outcome: 'READY_FOR_CUTOVER' as const,
        restoreRunId: runId,
        targetDatabase: input.targetDatabase,
        evidence,
      };
    } catch (error) {
      if (this.options.signal?.aborted) error = new RestoreCancelledError();
      if (target && !input.keepFailedTarget) {
        const { dropRestoreTargetIfCreated } = await import('./postgres.js');
        await dropRestoreTargetIfCreated(this.options.targetAdminDatabaseUrl!, target.targetDatabase).catch(() => undefined);
      }
      if (restoreRunCreated && repository?.updateRestoreRun) {
        if (error instanceof RestoreCancelledError) {
          await repository.updateRestoreRun(runId, { status: 'CANCELLED', completedAt: new Date(), failureCode: null });
        } else {
          const mapped = mapRestoreError(error);
          await repository.updateRestoreRun(runId, {
            status: 'FAILED',
            completedAt: new Date(),
            failureCode: persistedFailureCode(mapped),
          });
        }
      }
      if (error instanceof RestoreCancelledError) throw error;
      throw mapRestoreError(error);
    } finally {
      if (prepared) await removeRestoreWorkspace(prepared.workspace.root).catch(() => undefined);
    }
  }
}

async function verifyComponent(
  filePath: string,
  expected: { bytes: number; sha256: string },
  sidecarSha256: string,
): Promise<{ bytes: number; sha256: string }> {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || expected.bytes > MAX_RESTORE_COMPONENT_BYTES) {
    throw new RestoreOperationError('component size exceeds the supported restore bound', 'RESTORE_CHECKSUM_FAILED');
  }
  const file = await stat(filePath).catch(() => null);
  if (!file?.isFile() || file.size !== expected.bytes) throw new RestoreOperationError('component byte count does not match manifest', 'RESTORE_CHECKSUM_FAILED');
  const sha256 = await hashFile(filePath);
  if (!SHA256.test(sha256) || sha256 !== expected.sha256 || sha256 !== sidecarSha256) {
    throw new RestoreOperationError('component checksum does not match manifest and sidecar', 'RESTORE_CHECKSUM_FAILED');
  }
  return { bytes: file.size, sha256 };
}

async function persistDisasterRecoveryEvidence(
  targetDatabaseUrl: string,
  runId: string,
  targetDatabase: string,
  evidence: SafeRestoreEvidence,
  evidenceDirectory?: string,
): Promise<void> {
  const pool = new Pool({ connectionString: targetDatabaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    await pool.query(
      `INSERT INTO restore_runs
        (id, backup_id, mode, status, initiated_by, target_database, verification_result)
       VALUES ($1, NULL, 'DISASTER_RECOVERY', 'READY_FOR_CUTOVER', 'operator-cli', $2, $3)`,
      [runId, targetDatabase, JSON.stringify(evidence)],
    );
  } catch {
    const root = path.resolve(evidenceDirectory ?? process.env.RESTORE_EVIDENCE_DIR ?? path.join(os.tmpdir(), 'servora-med-restore-evidence'));
    await mkdir(root, { recursive: true, mode: 0o700 });
    const destination = path.join(root, `${runId}.json`);
    await import('node:fs/promises').then(({ writeFile }) => writeFile(destination, JSON.stringify({
      restoreRunId: runId,
      status: 'READY_FOR_CUTOVER',
      targetDatabase,
      evidence,
    }), { mode: 0o600, flag: 'wx' }));
  } finally {
    await pool.end();
  }
}
