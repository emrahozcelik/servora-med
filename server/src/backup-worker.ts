import { createBackupPipelineExecutor } from './modules/backup/pipeline.js';
import { CloudflareR2Storage } from './modules/backup/r2.js';
import { PostgresBackupRepository } from './modules/backup/repository.js';
import { BackupService } from './modules/backup/service.js';
import { BackupWorker } from './modules/backup/worker.js';
import { reclaimTerminalWorkspaces } from './modules/backup/workspace.js';
import { loadConfig } from './config.js';
import { closeDatabase, createDatabase } from './db/index.js';

export async function main(): Promise<void> {
  // Keep the disabled process fail-safe even when an API-only environment
  // omits DATABASE_URL and all backup secrets. Explicit `true` continues
  // through full configuration validation below; any other value is checked
  // by loadConfig when it is not the safe default `false`.
  const workerFlag = process.env.BACKUP_WORKER_ENABLED?.trim() ?? 'false';
  if (workerFlag === 'false') {
    console.info('Servora-Med backup worker disabled; no work claimed.');
    return;
  }
  const config = loadConfig();
  if (!config.backupWorker?.enabled) {
    console.info('Servora-Med backup worker disabled; no work claimed.');
    return;
  }
  if (!config.capabilities?.backup) {
    throw new Error('BACKUP_WORKER_ENABLED requires BACKUP_ENABLED=true');
  }
  const tempRoot = config.backupLocalEngine.tempRoot;
  const recipient = config.backupEncryption.recipient;
  const r2 = config.backupR2;
  if (!tempRoot || !recipient || !r2.accountId || !r2.accessKeyId || !r2.secretAccessKey
    || !r2.bucket || !r2.instanceId) {
    throw new Error(
      'BACKUP_WORKER_ENABLED requires BACKUP_TEMP_ROOT, BACKUP_ENCRYPTION_RECIPIENT, '
      + 'BACKUP_R2_ACCOUNT_ID, BACKUP_R2_ACCESS_KEY_ID, BACKUP_R2_SECRET_ACCESS_KEY, '
      + 'BACKUP_R2_BUCKET, and BACKUP_INSTANCE_ID',
    );
  }

  const database = createDatabase(config.databaseUrl, {
    applicationName: 'servora-med-backup-worker',
    max: 4,
  });
  const shutdownController = new AbortController();
  const storage = new CloudflareR2Storage({
    config: {
      accountId: r2.accountId,
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
      bucket: r2.bucket,
    },
    signal: shutdownController.signal,
  });
  const repository = new PostgresBackupRepository(database.pool);
  const service = new BackupService(repository);
  try {
    if (!(await repository.getWorkerState())) {
      throw new Error('backup worker runtime migration 033 is not applied');
    }
  } catch (error) {
    storage.destroy();
    await closeDatabase(database);
    throw error;
  }
  const worker = new BackupWorker({
    repository,
    service,
    enabled: true,
    leaseMs: config.backupWorker.leaseMs,
    heartbeatIntervalMs: config.backupWorker.heartbeatIntervalMs,
    pollIntervalMs: config.backupWorker.pollIntervalMs,
    executeRun: createBackupPipelineExecutor({
      repository,
      pool: database.pool,
      service,
      databaseUrl: config.databaseUrl,
      tempRoot,
      filesRoot: config.backupLocalEngine.filesRoot,
      recipient,
      storage,
      instanceId: r2.instanceId,
    }),
    onError: (error) => {
      console.error('Servora-Med backup worker tick failed', {
        errorCategory: error instanceof Error ? error.name : 'unknown',
      });
    },
    reclaimWorkspaces: async () => {
      await reclaimTerminalWorkspaces(tempRoot, repository);
    },
  });

  let stopping = false;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    void worker.stop().finally(() => {
      shutdownController.abort();
      resolveStopped();
    });
  };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  try {
    worker.start();
    await stopped;
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
    storage.destroy();
    await closeDatabase(database);
  }
}

await main().catch((error) => {
  console.error('Backup worker startup failed', error);
  process.exitCode = 1;
});
