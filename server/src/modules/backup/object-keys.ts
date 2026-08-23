import type { BackupRetentionClass } from './types.js';

/**
 * BR4 deterministic, privacy-preserving R2 object keys.
 *
 * Hierarchy (BR0 archive-and-storage §4):
 *   production/<instance-id>/v1/<retention>/<backup-id>.sbk.age
 *
 * No timestamps, no user/customer/organization names, no user-supplied
 * filenames: a key is fully derived from the installation identifier, the
 * retention class, and the backup UUID.
 */

export const REMOTE_OBJECT_ROOT = 'production';
export const REMOTE_OBJECT_FORMAT = 'v1';
export const REMOTE_OBJECT_SUFFIX = '.sbk.age';
export const CONNECTION_TEST_ROOT = '.connection-test';

const RETENTION_PATH_SEGMENTS: Readonly<Record<BackupRetentionClass, string>> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  MANUAL: 'manual',
  PRE_RESTORE: 'pre-restore',
};

// Conservative opaque installation identifier grammar (BR0): visible ASCII,
// single line, no path separators, no traversal, no whitespace/control
// characters, bounded length, no silent normalization.
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function validateBackupInstanceId(value: string): boolean {
  if (value.includes('..')) return false;
  return INSTANCE_ID_PATTERN.test(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Canonical remote object key for a backup's encrypted artifact. */
export function buildRemoteObjectKey(input: {
  instanceId: string;
  retentionClass: BackupRetentionClass;
  backupId: string;
}): string {
  if (!validateBackupInstanceId(input.instanceId)) {
    throw new Error('backup instance id is not a valid opaque identifier');
  }
  if (!UUID_PATTERN.test(input.backupId)) {
    throw new Error('backup id must be a uuid');
  }
  const segment = RETENTION_PATH_SEGMENTS[input.retentionClass];
  if (!segment) throw new Error('unknown retention class');
  return [
    REMOTE_OBJECT_ROOT,
    input.instanceId,
    REMOTE_OBJECT_FORMAT,
    segment,
    `${input.backupId.toLowerCase()}${REMOTE_OBJECT_SUFFIX}`,
  ].join('/');
}

/**
 * Reserved, non-restore-point key for the storage connection test probe.
 * Never inside a retention segment, so no lifecycle/Bucket-Lock retention
 * rule aimed at restore points can retain a probe object (the probe is an
 * aborted multipart upload, never a completed object).
 */
export function buildConnectionTestKey(instanceId: string, probeId: string): string {
  if (!validateBackupInstanceId(instanceId)) {
    throw new Error('backup instance id is not a valid opaque identifier');
  }
  if (!UUID_PATTERN.test(probeId)) {
    throw new Error('connection test probe id must be a uuid');
  }
  return [REMOTE_OBJECT_ROOT, instanceId, REMOTE_OBJECT_FORMAT, CONNECTION_TEST_ROOT, probeId].join('/');
}
