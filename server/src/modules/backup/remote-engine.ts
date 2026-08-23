import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { hashFile } from './engine.js';
import { buildRemoteObjectKey } from './object-keys.js';
import {
  CloudflareR2Storage,
  MAX_ATOMIC_PUT_BYTES,
  R2StorageError,
} from './r2.js';
import type { BackupRepository } from './repository.js';
import type { BackupService } from './service.js';
import type { BackupRun } from './types.js';
import { validateBackupInstanceId } from './object-keys.js';
import { workspacePathsFor } from './workspace.js';

/**
 * BR4 REMOTE BACKUP ENGINE.
 *
 * BR3 artifact (<run-id>.sbk.age, RUNNING @ ENCRYPT) → canonical R2 upload
 * (atomic conditional single PUT) →
 * streamed remote verification (HEAD metadata + full-body SHA-256 + byte
 * count) → recordVerification() → RUNNING @ CLEANUP. STOP.
 *
 * BR4 never calls completeRun(), never creates SUCCESS, never sets
 * verified_at, and never deletes remote objects or the local workspace.
 *
 * NO-OVERWRITE RECONCILIATION (approved 2026-08-23): R2 documents
 * If-None-Match for PutObject but no equivalent atomic destination condition
 * for CompleteMultipartUpload. BR4 therefore does not publish via multipart.
 * Objects above the R2 single-PUT ceiling fail closed before any remote write;
 * multipart is deferred until its no-overwrite contract can be reconciled.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

export type RemoteFailureCode =
  | 'R2_AUTH_FAILED'
  | 'R2_UPLOAD_FAILED'
  | 'R2_OBJECT_TOO_LARGE'
  | 'R2_OBJECT_CONFLICT'
  | 'R2_VERIFY_FAILED'
  | 'REMOTE_CHECKSUM_MISMATCH';

export type RemoteBackupResult =
  | {
    outcome: 'verified';
    runId: string;
    remoteKey: string;
    sizeBytes: number;
    sha256: string;
  }
  | {
    outcome: 'failed';
    runId: string;
    failureCode: RemoteFailureCode;
    failureSummary: string;
    diagnostics: string | null;
    /** Terminal integrity/config failures are persisted as FAILED. Retryable
     * transport failures leave the run RUNNING at `phase` so the BR5 worker
     * can re-enter the same phase under its bounded retry policy. */
    retryable: boolean;
    phase: BackupRun['phase'];
  };

class RemoteEngineFailure extends Error {
  constructor(
    readonly failureCode: RemoteFailureCode,
    readonly summary: string,
    readonly diagnostics: string | null = null,
    readonly retryable = false,
  ) {
    super(summary);
    this.name = 'RemoteEngineFailure';
  }
}

export type RemoteBackupEngineOptions = {
  repository: BackupRepository;
  service: BackupService;
  tempRoot: string;
  storage: CloudflareR2Storage;
  instanceId: string;
  /** Test-only lowering is allowed; production can never raise the documented
   * R2 atomic PutObject ceiling. */
  maxAtomicPutBytes?: number;
};

/** Narrow BR3 → BR4 handoff. A full successful LocalEncryptionResult is
 * structurally assignable; only the integrity-critical fields cross the
 * remote boundary. */
export type RemoteBackupHandoff = {
  runId: string;
  encryptedPath: string;
  ciphertextBytes: number;
  localCiphertextSha256: string;
};

export class RemoteBackupEngine {
  private readonly maxAtomicPutBytes: number;

  constructor(private readonly options: RemoteBackupEngineOptions) {
    if (!validateBackupInstanceId(options.instanceId)) {
      throw new Error('backup instance id is not a valid opaque identifier');
    }
    const limit = options.maxAtomicPutBytes ?? MAX_ATOMIC_PUT_BYTES;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_ATOMIC_PUT_BYTES) {
      throw new Error('max atomic put bytes must be within the supported R2 single-put limit');
    }
    this.maxAtomicPutBytes = limit;
  }

  /**
   * Full remote stage for a BR3-completed run: UPLOAD then REMOTE_VERIFY.
   * Requires RUNNING @ ENCRYPT.
   */
  async uploadAndVerifyRemoteBackup(handoff: RemoteBackupHandoff): Promise<RemoteBackupResult> {
    const run = await this.requireRunAtPhase(handoff.runId, 'ENCRYPT');
    return this.executeRemoteStage(run, handoff, { upload: true, enterUpload: true });
  }

  /** BR5 re-entry point for a retryable upload failure. The run stays at
   * UPLOAD and the same BR3 integrity handoff must be supplied again. */
  async retryUploadRemoteBackup(handoff: RemoteBackupHandoff): Promise<RemoteBackupResult> {
    const run = await this.requireRunAtPhase(handoff.runId, 'UPLOAD');
    return this.executeRemoteStage(run, handoff, { upload: true, enterUpload: false });
  }

  /**
   * Re-entry point for a crash/retry that already completed the upload but
   * not the verification (RUNNING @ REMOTE_VERIFY, no canonical evidence).
   * BR5's bounded phase retry uses this instead of re-uploading.
   */
  async verifyRemoteBackup(handoff: RemoteBackupHandoff): Promise<RemoteBackupResult> {
    const run = await this.requireRunAtPhase(handoff.runId, 'REMOTE_VERIFY');
    return this.executeRemoteStage(run, handoff, { upload: false, enterUpload: false });
  }

  private async requireRunAtPhase(
    runId: string,
    phase: 'ENCRYPT' | 'UPLOAD' | 'REMOTE_VERIFY',
  ): Promise<BackupRun> {
    const run = await this.options.repository.findRunById(runId);
    if (!run) throw new Error(`backup run not found: ${runId}`);
    if (run.status !== 'RUNNING' || run.phase !== phase) {
      throw new Error(
        `backup run ${runId} is not at ${phase} (status=${run.status}, phase=${run.phase ?? 'null'})`,
      );
    }
    return run;
  }

  private async executeRemoteStage(
    run: BackupRun,
    handoff: RemoteBackupHandoff,
    mode: { upload: boolean; enterUpload: boolean },
  ): Promise<RemoteBackupResult> {
    const { service, storage, tempRoot, instanceId } = this.options;
    try {
      const artifact = mode.upload
        ? await this.inspectLocalArtifact(run.id, tempRoot, handoff)
        : this.validateHandoff(run.id, tempRoot, handoff);
      const remoteKey = buildRemoteObjectKey({
        instanceId,
        retentionClass: run.retentionClass,
        backupId: run.id,
      });
      const metadata = {
        'servora-backup-id': run.id,
        'servora-format': '1',
        'servora-sha256': artifact.sha256,
      };

      if (mode.upload) {
        if (mode.enterUpload) await service.advancePhase(run.id, 'UPLOAD', false);

        const existing = await this.headWithFailureMapping(remoteKey);
        if (existing) {
          // §20 crash/retry semantics: never overwrite; an identical object
          // completes idempotently, anything else is a terminal conflict.
          await this.verifyObjectComposition(remoteKey, artifact, 'existing');
        } else {
          await this.uploadArtifact(remoteKey, artifact, metadata);
        }
        await service.advancePhase(run.id, 'REMOTE_VERIFY', false);
      }

      // Canonical three-way streamed verification (fresh upload AND
      // idempotent re-entry both prove the remote object end-to-end).
      const verified = await this.verifyObjectComposition(remoteKey, artifact, 'fresh');

      await service.recordVerification(run.id, {
        remoteKey,
        sizeBytes: verified.sizeBytes,
        sha256: verified.sha256,
      });
      await service.advancePhase(run.id, 'CLEANUP', false);

      return {
        outcome: 'verified',
        runId: run.id,
        remoteKey,
        sizeBytes: verified.sizeBytes,
        sha256: verified.sha256,
      };
    } catch (error) {
      // Only classified remote failures map to the taxonomy. Unexpected
      // errors (e.g. the local BR3 artifact missing, an invalid hash) are
      // recovery situations owned by BR5: rethrow so the caller sees the
      // contract violation and the run stays untouched — never terminalize
      // with an unrelated remote code.
      if (!(error instanceof RemoteEngineFailure)) throw error;
      const failure = error;
      const phase = await this.options.repository.findRunById(run.id)
        .then((current) => (current?.status === 'RUNNING' ? current.phase : failure.retryable ? 'UPLOAD' : null));
      if (!failure.retryable) {
        await service.markFailed(run.id, failure.failureCode, failure.summary);
      }
      return {
        outcome: 'failed',
        runId: run.id,
        failureCode: failure.failureCode,
        failureSummary: failure.summary,
        diagnostics: failure.diagnostics,
        retryable: failure.retryable,
        phase,
      };
    }
  }

  private validateHandoff(
    runId: string,
    tempRoot: string,
    handoff: RemoteBackupHandoff,
  ): { path: string; sha256: string; bytes: number; backupId: string } {
    if (handoff.runId !== runId) {
      throw new Error(`BR3 handoff run id does not match backup run ${runId}`);
    }
    if (!SHA256_HEX.test(handoff.localCiphertextSha256)) {
      throw new Error(`BR3 handoff ciphertext hash invalid for run ${runId}`);
    }
    if (!Number.isSafeInteger(handoff.ciphertextBytes) || handoff.ciphertextBytes <= 0) {
      throw new Error(`BR3 handoff ciphertext size invalid for run ${runId}`);
    }
    const paths = workspacePathsFor(tempRoot, runId);
    const artifactPath = path.join(paths.packagePath, `${runId}.sbk.age`);
    if (handoff.encryptedPath !== artifactPath) {
      throw new Error(`BR3 handoff artifact path is not canonical for run ${runId}`);
    }
    return {
      path: artifactPath,
      sha256: handoff.localCiphertextSha256,
      bytes: handoff.ciphertextBytes,
      backupId: runId,
    };
  }

  private async inspectLocalArtifact(
    runId: string,
    tempRoot: string,
    handoff: RemoteBackupHandoff,
  ): Promise<{
    path: string; sha256: string; bytes: number; backupId: string;
  }> {
    const expected = this.validateHandoff(runId, tempRoot, handoff);
    const paths = workspacePathsFor(tempRoot, runId);
    const workspaceStat = await lstat(paths.workspacePath).catch(() => null);
    const packageStat = await lstat(paths.packagePath).catch(() => null);
    const artifactStat = await lstat(expected.path).catch(() => null);
    if (!workspaceStat?.isDirectory() || !packageStat?.isDirectory()
      || !artifactStat?.isFile() || artifactStat.size <= 0) {
      // A BR3-completed run without its local ciphertext is a recovery
      // situation, not a deterministic remote failure: preserve the run for
      // BR5 adjudication instead of terminalizing it with an unrelated code.
      throw new Error(`expected regular encrypted artifact missing for run ${runId}`);
    }
    const workspaceReal = await realpath(paths.workspacePath);
    const artifactReal = await realpath(expected.path);
    const relative = path.relative(workspaceReal, artifactReal);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error(`encrypted artifact escapes expected workspace for run ${runId}`);
    }
    if (artifactStat.size !== expected.bytes) {
      throw new Error(`local ciphertext size differs from BR3 handoff for run ${runId}`);
    }
    // Re-stream the local SHA immediately before upload: the BR3 value is
    // the expected integrity anchor, but accidental local mutation must be
    // detected BEFORE the bytes are persisted remotely.
    const actualSha256 = await hashFile(expected.path);
    if (actualSha256 !== expected.sha256) {
      throw new Error(`local ciphertext hash differs from BR3 handoff for run ${runId}`);
    }
    return expected;
  }

  private async headWithFailureMapping(key: string) {
    try {
      return await this.options.storage.headObject(key);
    } catch (error) {
      throw this.mapStorageFailure(error, 'upload');
    }
  }

  private mapStorageFailure(error: unknown, stage: 'upload' | 'verify'): RemoteEngineFailure {
    if (!(error instanceof R2StorageError)) {
      return new RemoteEngineFailure(
        stage === 'upload' ? 'R2_UPLOAD_FAILED' : 'R2_VERIFY_FAILED',
        stage === 'upload'
          ? 'Uzak depolamaya yükleme başarısız oldu.'
          : 'Uzak doğrulama akışı okunamadı.',
        null,
        true,
      );
    }
    const diagnostics = error.detail;
    if (error.errorClass === 'AUTH') {
      return new RemoteEngineFailure('R2_AUTH_FAILED', 'Uzak yedekleme depolamasına erişilemedi.', null, false);
    }
    if (error.errorClass === 'OBJECT_TOO_LARGE') {
      return new RemoteEngineFailure(
        'R2_OBJECT_TOO_LARGE',
        'Şifreli yedek atomik R2 yükleme sınırını aşıyor.',
        null,
        false,
      );
    }
    if (stage === 'upload') {
      return new RemoteEngineFailure('R2_UPLOAD_FAILED', 'Uzak depolamaya yükleme başarısız oldu.', diagnostics, true);
    }
    return new RemoteEngineFailure('R2_VERIFY_FAILED', 'Uzak doğrulama akışı okunamadı.', diagnostics, true);
  }

  private async uploadArtifact(
    remoteKey: string,
    artifact: { path: string; sha256: string; bytes: number; backupId: string },
    metadata: { 'servora-backup-id': string; 'servora-format': string; 'servora-sha256': string },
  ): Promise<void> {
    const { storage } = this.options;
    if (artifact.bytes > this.maxAtomicPutBytes) {
      throw new RemoteEngineFailure(
        'R2_OBJECT_TOO_LARGE',
        'Şifreli yedek atomik R2 yükleme sınırını aşıyor.',
        null,
        false,
      );
    }
    let outcome: { outcome: 'created' } | { outcome: 'precondition-failed' };
    try {
      outcome = await storage.putObjectIfAbsent(remoteKey, {
        body: createReadStream(artifact.path),
        contentLength: artifact.bytes,
        metadata,
      });
    } catch (error) {
      throw this.mapStorageFailure(error, 'upload');
    }
    if (outcome.outcome === 'precondition-failed') {
      // A concurrent writer completed this exact deterministic key first.
      // Resolve §20 semantics instead of overwriting anything.
      const existing = await this.headWithFailureMapping(remoteKey);
      if (!existing) {
        throw new RemoteEngineFailure(
          'R2_UPLOAD_FAILED',
          'Uzak nesne koşulu çözülemedi.',
          'precondition failed but object disappeared',
          true,
        );
      }
      await this.verifyObjectComposition(remoteKey, artifact, 'existing');
    }
  }

  /**
   * The single canonical verification composition, reused by upload,
   * idempotent re-entry, and the internal reverify primitive:
   *   expected SHA == object metadata SHA == streamed remote SHA
   *   expected bytes == streamed remote byte count
   * `context: 'existing'` maps divergence to R2_OBJECT_CONFLICT (§20),
   * `context: 'fresh'` to REMOTE_CHECKSUM_MISMATCH (§30). Transport errors
   * are always retryable R2_VERIFY_FAILED.
   */
  private async verifyObjectComposition(
    remoteKey: string,
    expected: { sha256: string; bytes: number; backupId: string },
    context: 'existing' | 'fresh',
  ): Promise<{ sha256: string; sizeBytes: number }> {
    const mismatchCode: RemoteFailureCode = context === 'existing' ? 'R2_OBJECT_CONFLICT' : 'REMOTE_CHECKSUM_MISMATCH';
    const mismatch = (summary: string) => new RemoteEngineFailure(mismatchCode, summary, null, false);

    let head;
    try {
      head = await this.options.storage.headObject(remoteKey);
    } catch (error) {
      throw this.mapStorageFailure(error, 'verify');
    }
    if (!head) {
      throw mismatch('Uzak yedek nesnesi bulunamadı.');
    }
    const validateEvidence = (evidence: {
      contentLength: number;
      metadata: Record<string, string>;
    }) => {
      const metadataSha = evidence.metadata['servora-sha256'];
      const metadataBackupId = evidence.metadata['servora-backup-id'];
      const metadataFormat = evidence.metadata['servora-format'];
      if (metadataSha === undefined || metadataBackupId === undefined || metadataFormat === undefined) {
        throw mismatch('Uzak nesne meta verisi eksik.');
      }
      if (metadataSha !== expected.sha256 || !SHA256_HEX.test(metadataSha)) {
        throw mismatch('Uzak nesne checksum meta verisi beklenenle uyuşmuyor.');
      }
      if (metadataFormat !== '1') {
        throw mismatch('Uzak nesne format meta verisi geçersiz.');
      }
      if (evidence.contentLength !== expected.bytes) {
        throw mismatch('Uzak nesne boyutu beklenenle uyuşmuyor.');
      }
      if (metadataBackupId.toLowerCase() !== expected.backupId.toLowerCase()) {
        throw mismatch('Uzak nesne yedek kimliği beklenenle uyuşmuyor.');
      }
    };
    validateEvidence(head);

    let object: Awaited<ReturnType<CloudflareR2Storage['getObject']>>;
    try {
      object = await this.options.storage.getObject(remoteKey, head.etag ?? undefined);
    } catch (error) {
      if (error instanceof R2StorageError && error.errorClass === 'PRECONDITION_FAILED') {
        throw mismatch('Uzak nesne doğrulama sırasında değişti.');
      }
      throw this.mapStorageFailure(error, 'verify');
    }
    if (!object) throw mismatch('Uzak yedek nesnesi bulunamadı.');
    validateEvidence(object);
    const hash = createHash('sha256');
    let sizeBytes = 0;
    try {
      for await (const chunk of object.body) {
        sizeBytes += chunk.byteLength;
        hash.update(chunk);
      }
    } catch (error) {
      throw this.mapStorageFailure(error, 'verify');
    }
    const streamedSha = hash.digest('hex');
    if (streamedSha !== expected.sha256 || sizeBytes !== expected.bytes) {
      throw mismatch('Uzak nesne içeriği beklenen checksum ile uyuşmuyor.');
    }
    return { sha256: streamedSha, sizeBytes };
  }

  /**
   * Internal reverify primitive (read-only): recomputes the canonical
   * composition against the STORED canonical evidence of a run that already
   * has remote_key/sha256/size_bytes. Persists nothing and never mutates
   * run state — a failed reverify must not touch a terminal SUCCESS row,
   * and there is no approved verified_at-refresh primitive in BR1, so none
   * is invented here. BR5/BR6 decide persistence semantics later.
   */
  async reverify(runId: string): Promise<
    | { outcome: 'pass'; remoteKey: string; sha256: string; sizeBytes: number }
    | { outcome: 'failed'; failureCode: RemoteFailureCode; failureSummary: string }
  > {
    const run = await this.options.repository.findRunById(runId);
    if (!run) throw new Error(`backup run not found: ${runId}`);
    if (!run.remoteKey || !run.sha256 || run.sizeBytes === null) {
      throw new Error(`backup run ${runId} has no canonical remote verification evidence to reverify`);
    }
    try {
      const verified = await this.verifyObjectComposition(run.remoteKey, {
        sha256: run.sha256,
        bytes: run.sizeBytes,
        backupId: run.id,
      }, 'fresh');
      return {
        outcome: 'pass',
        remoteKey: run.remoteKey,
        sha256: verified.sha256,
        sizeBytes: verified.sizeBytes,
      };
    } catch (error) {
      if (error instanceof RemoteEngineFailure) {
        return { outcome: 'failed', failureCode: error.failureCode, failureSummary: error.summary };
      }
      return { outcome: 'failed', failureCode: 'R2_VERIFY_FAILED', failureSummary: 'Yeniden doğrulama başarısız oldu.' };
    }
  }
}
