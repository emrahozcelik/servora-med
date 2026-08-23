import type { RestoreMode } from '../modules/backup/types.js';
import { CloudflareR2Storage } from '../modules/backup/r2.js';
import { RestoreOperationError, RestoreService } from '../modules/backup/restore/service.js';
import { validateBackupInstanceId } from '../modules/backup/object-keys.js';

const TARGET_DATABASE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export type RestoreCliInvocation = {
  command: 'list' | 'inspect' | 'verify' | 'restore';
  remote: boolean;
  json: boolean;
  archiveOrId?: string;
  targetDatabase?: string;
  mode: RestoreMode;
  identityPath?: string;
  expectedSha256?: string;
  targetFilesRoot?: string;
  keepFailedTarget: boolean;
  acknowledgeDestructiveRestore: boolean;
};

export class RestoreCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreCliUsageError';
  }
}

function valueAfter(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new RestoreCliUsageError(`${flag} requires a value`);
  return value;
}

export function parseRestoreCliArgs(argv: readonly string[]): RestoreCliInvocation {
  const command = argv[0];
  if (command !== 'list' && command !== 'inspect' && command !== 'verify' && command !== 'restore') {
    throw new RestoreCliUsageError('command must be list, inspect, verify, or restore');
  }
  let remote = false;
  let json = false;
  let archiveOrId: string | undefined;
  let targetDatabase: string | undefined;
  let mode: RestoreMode = 'REHEARSAL';
  let identityPath: string | undefined;
  let expectedSha256: string | undefined;
  let targetFilesRoot: string | undefined;
  let keepFailedTarget = false;
  let acknowledgeDestructiveRestore = false;
  const seen = new Set<string>();
  const setOnce = (name: string) => {
    if (seen.has(name)) throw new RestoreCliUsageError(`${name} was specified more than once`);
    seen.add(name);
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      if (archiveOrId) throw new RestoreCliUsageError('only one archive-or-id argument is allowed');
      archiveOrId = token;
      continue;
    }
    switch (token) {
      case '--remote':
        setOnce('--remote');
        remote = true;
        break;
      case '--json':
        setOnce('--json');
        json = true;
        break;
      case '--i-accept-destructive-restore':
        setOnce('--i-accept-destructive-restore');
        acknowledgeDestructiveRestore = true;
        break;
      case '--keep-failed-target':
        setOnce('--keep-failed-target');
        keepFailedTarget = true;
        break;
      case '--target-db':
        setOnce('--target-db');
        targetDatabase = valueAfter(argv, index, token);
        index += 1;
        break;
      case '--mode': {
        setOnce('--mode');
        const value = valueAfter(argv, index, token).toLowerCase();
        if (value !== 'rehearsal' && value !== 'disaster-recovery') {
          throw new RestoreCliUsageError('--mode must be rehearsal or disaster-recovery');
        }
        mode = value === 'rehearsal' ? 'REHEARSAL' : 'DISASTER_RECOVERY';
        index += 1;
        break;
      }
      case '--identity':
        setOnce('--identity');
        identityPath = valueAfter(argv, index, token);
        index += 1;
        break;
      case '--expected-sha256':
        setOnce('--expected-sha256');
        expectedSha256 = valueAfter(argv, index, token);
        if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
          throw new RestoreCliUsageError('--expected-sha256 must be lowercase SHA-256');
        }
        index += 1;
        break;
      case '--target-files-root':
        setOnce('--target-files-root');
        targetFilesRoot = valueAfter(argv, index, token);
        index += 1;
        break;
      default:
        throw new RestoreCliUsageError(`unknown option: ${token}`);
    }
  }

  if (command === 'list') {
    if (!remote) throw new RestoreCliUsageError('list requires --remote');
    if (archiveOrId) throw new RestoreCliUsageError('list does not accept an archive-or-id');
    if (identityPath || expectedSha256) throw new RestoreCliUsageError('list does not accept identity or checksum options');
  } else if (!archiveOrId) {
    throw new RestoreCliUsageError(`${command} requires an archive-or-id`);
  }
  if (command === 'restore') {
    if (!targetDatabase || !TARGET_DATABASE.test(targetDatabase)) {
      throw new RestoreCliUsageError('--target-db must be a strict PostgreSQL identifier');
    }
    if (!acknowledgeDestructiveRestore) {
      throw new RestoreCliUsageError('restore requires --i-accept-destructive-restore acknowledgement');
    }
  } else if (targetDatabase || acknowledgeDestructiveRestore || targetFilesRoot || keepFailedTarget || mode !== 'REHEARSAL') {
    throw new RestoreCliUsageError('restore-only options were supplied to a read-only command');
  }
  return {
    command,
    remote,
    json,
    archiveOrId,
    targetDatabase,
    mode,
    identityPath,
    expectedSha256,
    targetFilesRoot,
    keepFailedTarget,
    acknowledgeDestructiveRestore,
  };
}

export function isRestoreCliEntrypoint(): boolean {
  return process.argv[1]?.endsWith('/servora-backup.js') === true
    || process.argv[1]?.endsWith('/servora-backup.ts') === true;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new RestoreOperationError(`${name} is required`);
  return value;
}

function serviceFor(invocation: RestoreCliInvocation, signal: AbortSignal): RestoreService {
  const sourceIsUuid = invocation.archiveOrId
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invocation.archiveOrId)
    : false;
  const needsRemote = invocation.command === 'list' || invocation.remote || sourceIsUuid;
  const storage = needsRemote
    ? new CloudflareR2Storage({
      config: {
        accountId: requiredEnvironment('BACKUP_R2_ACCOUNT_ID'),
        accessKeyId: requiredEnvironment('BACKUP_R2_ACCESS_KEY_ID'),
        secretAccessKey: requiredEnvironment('BACKUP_R2_SECRET_ACCESS_KEY'),
        bucket: requiredEnvironment('BACKUP_R2_BUCKET'),
      },
      signal,
    })
    : undefined;
  const instanceId = needsRemote ? requiredEnvironment('BACKUP_INSTANCE_ID') : undefined;
  if (instanceId && !validateBackupInstanceId(instanceId)) throw new RestoreOperationError('BACKUP_INSTANCE_ID is invalid');
  return new RestoreService({
    storage,
    instanceId,
    targetAdminDatabaseUrl: process.env.RESTORE_TARGET_DATABASE_URL,
    controlDatabaseUrl: process.env.RESTORE_CONTROL_DATABASE_URL,
    productionDatabaseUrl: process.env.PRODUCTION_DATABASE_URL ?? process.env.RESTORE_PRODUCTION_DATABASE_URL,
    identityPath: invocation.identityPath,
    workspaceRoot: process.env.RESTORE_WORKSPACE_ROOT,
    filesRoot: process.env.BACKUP_FILES_ROOT,
    evidenceDirectory: process.env.RESTORE_EVIDENCE_DIR,
    signal,
  });
}

export async function runRestoreCli(argv: readonly string[], output: (line: string) => void = console.log): Promise<unknown> {
  const invocation = parseRestoreCliArgs(argv);
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const service = serviceFor(invocation, controller.signal);
    if (invocation.command === 'list') {
      const result = await service.listRemote();
      if (invocation.json) output(JSON.stringify(result));
      else for (const item of result.items) output(`${item.backupId} ${item.retentionClass} ${item.sizeBytes ?? '-'} ${item.lastModified ?? '-'}`);
      return result;
    }
    if (!invocation.archiveOrId) throw new RestoreCliUsageError('archive-or-id is required');
    if (invocation.command === 'inspect') {
      const result = await service.inspect({ archiveOrId: invocation.archiveOrId, remote: invocation.remote, expectedSha256: invocation.expectedSha256 });
      output(JSON.stringify(result));
      return result;
    }
    if (invocation.command === 'verify') {
      const result = await service.verify({ archiveOrId: invocation.archiveOrId, remote: invocation.remote, expectedSha256: invocation.expectedSha256 });
      output(JSON.stringify(result));
      return result;
    }
    const result = await service.restore({
      archiveOrId: invocation.archiveOrId,
      mode: invocation.mode,
      targetDatabase: invocation.targetDatabase!,
      acknowledgeDestructiveRestore: invocation.acknowledgeDestructiveRestore,
      expectedSha256: invocation.expectedSha256,
      targetFilesRoot: invocation.targetFilesRoot,
      keepFailedTarget: invocation.keepFailedTarget,
    });
    output(JSON.stringify(result));
    return result;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

if (isRestoreCliEntrypoint()) {
  runRestoreCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof RestoreCliUsageError || error instanceof RestoreOperationError
      ? error.message
      : 'restore command failed';
    console.error(message);
    process.exitCode = 1;
  });
}
