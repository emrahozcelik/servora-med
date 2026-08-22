// Backup & Recovery V1 domain foundation (BR1).
// Contracts are authoritative in docs/operations/backup-recovery/ (BR0) and
// DECISIONS.md OPS-002. This module owns metadata only — no pg_dump, no
// encryption, no R2, no worker, no restore execution.

export const BACKUP_RUN_STATUSES = [
  'QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED',
] as const;
export type BackupRunStatus = (typeof BACKUP_RUN_STATUSES)[number];

export const BACKUP_RUN_PHASES = [
  'PREFLIGHT', 'DATABASE_DUMP', 'FILES_ARCHIVE', 'MANIFEST', 'CHECKSUM',
  'PACKAGE', 'ENCRYPT', 'UPLOAD', 'REMOTE_VERIFY', 'CLEANUP',
] as const;
export type BackupRunPhase = (typeof BACKUP_RUN_PHASES)[number];

export const BACKUP_ORIGINS = ['MANUAL', 'SCHEDULED', 'PRE_RESTORE'] as const;
export type BackupOrigin = (typeof BACKUP_ORIGINS)[number];

export const BACKUP_SCOPES = ['DATABASE', 'FULL_DATA'] as const;
export type BackupScope = (typeof BACKUP_SCOPES)[number];

export const BACKUP_RETENTION_CLASSES = [
  'DAILY', 'WEEKLY', 'MONTHLY', 'MANUAL', 'PRE_RESTORE',
] as const;
export type BackupRetentionClass = (typeof BACKUP_RETENTION_CLASSES)[number];

export const BACKUP_FAILURE_CODES = [
  'PREFLIGHT_DATABASE_UNAVAILABLE',
  'PREFLIGHT_PG_DUMP_UNAVAILABLE',
  'PREFLIGHT_LOW_DISK',
  'PREFLIGHT_STORAGE_UNAVAILABLE',
  'PG_DUMP_FAILED',
  'FILES_ARCHIVE_FAILED',
  'MANIFEST_FAILED',
  'PACKAGE_FAILED',
  'ENCRYPTION_FAILED',
  'R2_AUTH_FAILED',
  'R2_UPLOAD_FAILED',
  'R2_DOWNLOAD_FAILED',
  'REMOTE_CHECKSUM_MISMATCH',
  'WORKER_LOST',
] as const;
export type BackupFailureCode = (typeof BACKUP_FAILURE_CODES)[number];

export const BACKUP_WARNING_CODES = ['CLEANUP_FAILED'] as const;
export type BackupWarningCode = (typeof BACKUP_WARNING_CODES)[number];

export const RESTORE_RUN_STATUSES = [
  'RUNNING', 'READY_FOR_CUTOVER', 'COMPLETED', 'FAILED', 'CANCELLED',
] as const;
export type RestoreRunStatus = (typeof RESTORE_RUN_STATUSES)[number];

export const RESTORE_MODES = ['REHEARSAL', 'DISASTER_RECOVERY'] as const;
export type RestoreMode = (typeof RESTORE_MODES)[number];

export const RESTORE_FAILURE_CODES = [
  'RESTORE_MANIFEST_INVALID',
  'RESTORE_FORMAT_UNSUPPORTED',
  'RESTORE_CHECKSUM_FAILED',
  'RESTORE_DATABASE_CREATE_FAILED',
  'RESTORE_PG_RESTORE_FAILED',
  'RESTORE_INTEGRITY_FAILED',
] as const;
export type RestoreFailureCode = (typeof RESTORE_FAILURE_CODES)[number];

/**
 * Shared backup/restore mutual-exclusion advisory lock namespace.
 * The future worker (BR5) and restore CLI (BR7) MUST use this exact key for
 * cross-process exclusion (single active backup, backup XOR restore).
 * Application lock id must stay within the 2^31-1 int4 range.
 */
export const BACKUP_EXCLUSION_ADVISORY_LOCK_KEY = 872_014_030;

export type BackupRun = {
  id: string;
  status: BackupRunStatus;
  phase: BackupRunPhase | null;
  origin: BackupOrigin;
  scope: BackupScope;
  retentionClass: BackupRetentionClass;
  createdBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  formatVersion: number;
  appVersion: string | null;
  gitCommit: string | null;
  schemaVersion: string | null;
  databaseServerVersion: string | null;
  dumpVersion: number | null;
  remoteKey: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  verifiedAt: Date | null;
  warningCode: BackupWarningCode | null;
  warningSummary: string | null;
  failureCode: BackupFailureCode | null;
  failureSummary: string | null;
};

export type BackupRunPage = {
  items: BackupRun[];
  nextCursor: BackupCursor | null;
};

export type BackupRunDto = {
  id: string;
  status: BackupRunStatus;
  phase: BackupRunPhase | null;
  origin: BackupOrigin;
  scope: BackupScope;
  retentionClass: BackupRetentionClass;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  formatVersion: number;
  remoteKey: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  verifiedAt: string | null;
  warningCode: BackupWarningCode | null;
  warningSummary: string | null;
  failureCode: BackupFailureCode | null;
  failureSummary: string | null;
};

export type BackupCursor = { createdAt: Date; id: string };

export type BackupRunPageQuery = {
  limit: number;
  cursor: BackupCursor | null;
};

export type BackupPolicy = {
  id: string;
  enabled: boolean;
  scheduleTimeLocal: string;
  timezone: string;
  dailyRetention: number;
  weeklyRetention: number;
  monthlyRetention: number;
  defaultScope: BackupScope;
  updatedAt: Date;
  updatedBy: string | null;
};

export type BackupPolicyUpdate = {
  enabled: boolean;
  scheduleTimeLocal: string;
  timezone: string;
  dailyRetention: number;
  weeklyRetention: number;
  monthlyRetention: number;
  defaultScope: BackupScope;
};

export type BackupStorageState = {
  provider: 'CLOUDFLARE_R2';
  bucketAlias: string | null;
  prefix: string;
  enabled: boolean;
  lastConnectionTestAt: Date | null;
  lastConnectionTestOk: boolean | null;
};

export type RestoreRun = {
  id: string;
  backupId: string | null;
  mode: RestoreMode;
  status: RestoreRunStatus;
  startedAt: Date;
  completedAt: Date | null;
  initiatedBy: string;
  targetDatabase: string;
  preRestoreBackupId: string | null;
  verificationResult: Record<string, unknown> | null;
  failureCode: RestoreFailureCode | null;
};

export type BackupAuditInput = {
  organizationId: string;
  actorUserId: string;
  subjectType: 'BACKUP_RUN' | 'BACKUP_POLICY';
  subjectId: string;
  eventType: 'BACKUP_REQUESTED' | 'BACKUP_POLICY_UPDATED';
  metadata: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// State machine (canonical transitions; BR0 architecture §7).
// The worker does not exist in BR1 — these primitives are the domain contract
// the BR5 worker will execute. Nothing may bypass them with raw field writes.
// ---------------------------------------------------------------------------

export const BACKUP_STATUS_TRANSITIONS: Readonly<Record<BackupRunStatus, readonly BackupRunStatus[]>> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['SUCCESS', 'FAILED', 'CANCELLED'],
  SUCCESS: [],
  FAILED: [],
  CANCELLED: [],
};

export function isValidStatusTransition(from: BackupRunStatus, to: BackupRunStatus): boolean {
  return BACKUP_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Phases strictly advance while RUNNING; retry may re-enter the SAME phase.
 *
 * FILES_ARCHIVE is the only skippable phase, and only when this run does not
 * require a files archive. Whether a files archive is required is an
 * EXECUTION-CONTEXT fact resolved by the caller (BR2/BR5 worker):
 * scope alone does not decide it — a FULL_DATA run without configured
 * persistent files skips FILES_ARCHIVE too (BR0 architecture §7.2).
 */
export function isValidPhaseTransition(
  from: BackupRunPhase,
  to: BackupRunPhase,
  context: { filesArchiveRequired: boolean },
): boolean {
  const order: readonly BackupRunPhase[] = BACKUP_RUN_PHASES;
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  if (toIndex === fromIndex) return true; // same-phase retry
  if (toIndex < fromIndex) return false; // backward transition
  const skipped = order.slice(fromIndex + 1, toIndex);
  // Only the phases strictly between from and to are "skipped"; the only
  // skippable phase is FILES_ARCHIVE, and only when it is not required.
  return skipped.every((phase) => phase === 'FILES_ARCHIVE' && !context.filesArchiveRequired);
}

/**
 * Domain derivation of the files-archive requirement for the worker (BR2/BR5):
 * FILES_ARCHIVE runs only for FULL_DATA scope with configured persistent
 * files; otherwise it is contractually skipped.
 */
export function filesArchiveRequiredFor(
  scope: BackupScope,
  persistentFilesConfigured: boolean,
): boolean {
  return scope === 'FULL_DATA' && persistentFilesConfigured;
}

export type BackupCriticalActionClaim = {
  organizationId: string;
  userId: string;
  clientActionId: string;
  operationKey: string;
};
