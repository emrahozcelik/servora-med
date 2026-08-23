import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { Pool } from 'pg';

import {
  hashFile,
  LocalBackupEngine,
  type LocalBackupEngineOptions,
} from './engine.js';
import {
  LocalEncryptionEngine,
  type LocalEncryptionEngineOptions,
} from './encryption.js';
import {
  RemoteBackupEngine,
  type RemoteBackupEngineOptions,
  type RemoteBackupHandoff,
} from './remote-engine.js';
import type { BackupWorkerRepository } from './repository.js';
import { removeWorkspace, workspacePathsFor } from './workspace.js';
import { isRetryableBackupFailure } from './retry.js';
import type { BackupServiceTransitionPrimitives } from './service.js';
import type { BackupFailureCode, BackupWorkerClaim } from './types.js';
import type { BackupWorkerExecutionContext, BackupWorkerExecutionOutcome } from './worker.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export type BackupPipelineOptions = {
  repository: BackupWorkerRepository;
  pool: Pool;
  service: BackupServiceTransitionPrimitives;
  databaseUrl: string;
  tempRoot: string;
  filesRoot: string | null;
  recipient: string;
  storage: RemoteBackupEngineOptions['storage'];
  instanceId: string;
  application?: LocalBackupEngineOptions['application'];
};

function terminalFailure(
  failureCode: BackupFailureCode,
  failureSummary: string,
  persisted = true,
): BackupWorkerExecutionOutcome {
  return { kind: 'terminal-failure', failureCode, failureSummary, persisted };
}

function retryableFailure(
  failureCode: BackupFailureCode,
  failureSummary: string,
): BackupWorkerExecutionOutcome {
  if (!isRetryableBackupFailure(failureCode)) {
    return terminalFailure(failureCode, failureSummary, false);
  }
  return { kind: 'retryable-failure', failureCode, failureSummary };
}

async function encryptedHandoff(
  tempRoot: string,
  runId: string,
): Promise<RemoteBackupHandoff> {
  const paths = workspacePathsFor(tempRoot, runId);
  const encryptedPath = path.join(paths.packagePath, `${runId}.sbk.age`);
  const metadata = await stat(encryptedPath).catch(() => null);
  if (!metadata?.isFile() || metadata.size <= 0) {
    throw new Error(`encrypted artifact missing for backup run ${runId}`);
  }
  return {
    runId,
    encryptedPath,
    ciphertextBytes: metadata.size,
    localCiphertextSha256: await hashFile(encryptedPath),
  };
}

async function completeCleanup(
  runId: string,
  tempRoot: string,
  repository: BackupWorkerRepository,
  context: BackupWorkerExecutionContext,
): Promise<BackupWorkerExecutionOutcome> {
  let cleanupWarning: string | undefined;
  try {
    await removeWorkspace(tempRoot, runId);
  } catch {
    // Never expose an absolute path or an exception detail in operator data.
    cleanupWarning = 'Yerel çalışma alanı temizlenemedi; uzak doğrulama korunarak tamamlandı.';
  }
  await context.service.completeRun(
    runId,
    cleanupWarning ? { cleanupWarning } : undefined,
  );
  await repository.appendSystemBackupAudit(runId, 'BACKUP_COMPLETED', {
    status: 'SUCCESS',
    warningCode: cleanupWarning ? 'CLEANUP_FAILED' : null,
  });
  return { kind: 'completed' };
}

/**
 * Composes BR2 → BR3 → BR4 with the BR5 cleanup handoff. Engines retain their
 * narrow responsibilities; the worker is the only caller that decides when a
 * retryable result re-enters the same phase and when CLEANUP may terminalize.
 */
export function createBackupPipelineExecutor(options: BackupPipelineOptions) {
  return async function executeBackupClaim(
    claim: BackupWorkerClaim,
    context: BackupWorkerExecutionContext,
  ): Promise<BackupWorkerExecutionOutcome> {
    const service = context.service;
    let run = await options.repository.findRunById(claim.run.id);
    if (!run || run.status !== 'RUNNING') {
      throw new Error(`claimed backup run is no longer running: ${claim.run.id}`);
    }

    if (run.phase === 'CLEANUP') {
      if (
        run.remoteKey
        && run.remoteKey.trim().length > 0
        && run.sha256
        && SHA256_HEX.test(run.sha256)
        && run.sizeBytes !== null
        && run.sizeBytes > 0
      ) {
        await options.repository.appendSystemBackupAudit(run.id, 'BACKUP_VERIFIED', {
          scope: run.scope,
          origin: run.origin,
          retentionClass: run.retentionClass,
          phase: run.phase,
        });
      }
      return completeCleanup(run.id, options.tempRoot, options.repository, context);
    }

    const localEngine = new LocalBackupEngine({
      repository: options.repository,
      service,
      pool: options.pool,
      databaseUrl: options.databaseUrl,
      tempRoot: options.tempRoot,
      filesRoot: options.filesRoot,
      application: options.application,
      deferRetryableFailures: true,
    });
    const encryptionEngine = new LocalEncryptionEngine({
      repository: options.repository,
      service,
      tempRoot: options.tempRoot,
      recipient: options.recipient,
    });
    const remoteEngine = new RemoteBackupEngine({
      repository: options.repository,
      service,
      tempRoot: options.tempRoot,
      storage: options.storage,
      instanceId: options.instanceId,
    });

    if (run.phase === 'PREFLIGHT') {
      const local = await localEngine.buildLocalBackup(run.id);
      if (local.outcome === 'failed') {
        return local.retryable
          ? retryableFailure(local.failureCode, local.failureSummary)
          : terminalFailure(local.failureCode, local.failureSummary);
      }
      run = await options.repository.findRunById(run.id);
      if (!run) throw new Error(`backup run disappeared after local package: ${claim.run.id}`);
    }

    if (run.phase === 'PACKAGE') {
      const encrypted = await encryptionEngine.encryptLocalBackup(run.id);
      if (encrypted.outcome === 'failed') {
        return terminalFailure(encrypted.failureCode, encrypted.failureSummary);
      }
      run = await options.repository.findRunById(run.id);
      if (!run) throw new Error(`backup run disappeared after encryption: ${claim.run.id}`);
    }

    if (run.phase === 'ENCRYPT' || run.phase === 'UPLOAD' || run.phase === 'REMOTE_VERIFY') {
      const handoff = await encryptedHandoff(options.tempRoot, run.id);
      const remote = run.phase === 'ENCRYPT'
        ? await remoteEngine.uploadAndVerifyRemoteBackup(handoff)
        : run.phase === 'UPLOAD'
          ? await remoteEngine.retryUploadRemoteBackup(handoff)
          : await remoteEngine.verifyRemoteBackup(handoff);
      if (remote.outcome === 'failed') {
        return remote.retryable
          ? retryableFailure(remote.failureCode, remote.failureSummary)
          : terminalFailure(remote.failureCode, remote.failureSummary);
      }
      await options.repository.appendSystemBackupAudit(run.id, 'BACKUP_VERIFIED', {
        scope: run.scope,
        origin: run.origin,
        retentionClass: run.retentionClass,
        phase: 'REMOTE_VERIFY',
      });
      run = await options.repository.findRunById(run.id);
      if (!run) throw new Error(`backup run disappeared after remote verification: ${claim.run.id}`);
    }

    if (run.phase === 'CLEANUP') {
      return completeCleanup(run.id, options.tempRoot, options.repository, context);
    }
    throw new Error(`backup run ${run.id} stopped at unsupported phase ${run.phase ?? 'null'}`);
  };
}
