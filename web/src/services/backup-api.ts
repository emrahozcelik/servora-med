import {
  ApiError,
  boolean,
  items,
  json,
  nullableString,
  number,
  object,
  request,
  string,
} from './api';

export type BackupRunStatus = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
export type BackupRunPhase =
  | 'PREFLIGHT' | 'DATABASE_DUMP' | 'FILES_ARCHIVE' | 'MANIFEST' | 'CHECKSUM'
  | 'PACKAGE' | 'ENCRYPT' | 'UPLOAD' | 'REMOTE_VERIFY' | 'CLEANUP';
export type BackupOrigin = 'MANUAL' | 'SCHEDULED' | 'PRE_RESTORE';
export type BackupScope = 'DATABASE' | 'FULL_DATA';
export type BackupRetentionClass = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'MANUAL' | 'PRE_RESTORE';

export type BackupRun = {
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
  warningCode: 'CLEANUP_FAILED' | null;
  warningSummary: string | null;
  failureCode: string | null;
  failureSummary: string | null;
};

export type BackupRunPage = { items: BackupRun[]; nextCursor: string | null };

export type BackupPolicy = {
  id: string;
  enabled: boolean;
  scheduleTimeLocal: string;
  timezone: string;
  dailyRetention: number;
  weeklyRetention: number;
  monthlyRetention: number;
  defaultScope: BackupScope;
  updatedAt: string;
  updatedBy: string | null;
};

export type BackupStorageState = {
  provider: 'CLOUDFLARE_R2';
  bucketAlias: string | null;
  prefix: string;
  enabled: boolean;
  lastConnectionTestAt: string | null;
  lastConnectionTestOk: boolean | null;
};

export type BackupWorkerState = {
  workerHeartbeatAt: string | null;
  schedulerLastTickAt: string | null;
  lastScheduledFor: string | null;
};

export type BackupOverview = {
  lastVerifiedBackup: Omit<BackupRun, 'remoteKey' | 'sha256'> | null;
  activeRun: Omit<BackupRun, 'remoteKey' | 'sha256'> | null;
  nextScheduledAt: string | null;
  scheduleTimezone: string | null;
  worker: BackupWorkerState | null;
};

export type BackupHealth = {
  status: 'ok' | 'unavailable';
  latestVerifiedAt: string | null;
  latestScheduledVerifiedAt: string | null;
  latestRunStatus: string | null;
  latestScheduledRunStatus: string | null;
  workerHeartbeatAt: string | null;
  schedulerLastTickAt: string | null;
};

export type BackupPolicyInput = Omit<BackupPolicy, 'id' | 'updatedAt' | 'updatedBy'>;

function enumValue<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  const candidate = string(value, field);
  if (!values.includes(candidate as T)) {
    throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
  }
  return candidate as T;
}

function nullable(value: unknown, field: string): string | null {
  return value === null ? null : nullableString(value, field);
}

function parseRun(value: unknown): BackupRun {
  const item = object(value);
  return {
    id: string(item.id, 'id'),
    status: enumValue(item.status, 'status', ['QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED'] as const),
    phase: item.phase === null ? null : enumValue(item.phase, 'phase', [
      'PREFLIGHT', 'DATABASE_DUMP', 'FILES_ARCHIVE', 'MANIFEST', 'CHECKSUM',
      'PACKAGE', 'ENCRYPT', 'UPLOAD', 'REMOTE_VERIFY', 'CLEANUP',
    ] as const),
    origin: enumValue(item.origin, 'origin', ['MANUAL', 'SCHEDULED', 'PRE_RESTORE'] as const),
    scope: enumValue(item.scope, 'scope', ['DATABASE', 'FULL_DATA'] as const),
    retentionClass: enumValue(item.retentionClass, 'retentionClass', ['DAILY', 'WEEKLY', 'MONTHLY', 'MANUAL', 'PRE_RESTORE'] as const),
    createdBy: nullable(item.createdBy, 'createdBy'),
    createdAt: string(item.createdAt, 'createdAt'),
    startedAt: nullable(item.startedAt, 'startedAt'),
    completedAt: nullable(item.completedAt, 'completedAt'),
    formatVersion: number(item.formatVersion, 'formatVersion'),
    remoteKey: nullable(item.remoteKey, 'remoteKey'),
    sizeBytes: item.sizeBytes === null ? null : number(item.sizeBytes, 'sizeBytes'),
    sha256: nullable(item.sha256, 'sha256'),
    verifiedAt: nullable(item.verifiedAt, 'verifiedAt'),
    warningCode: item.warningCode === null ? null : enumValue(item.warningCode, 'warningCode', ['CLEANUP_FAILED'] as const),
    warningSummary: nullable(item.warningSummary, 'warningSummary'),
    failureCode: nullable(item.failureCode, 'failureCode'),
    failureSummary: nullable(item.failureSummary, 'failureSummary'),
  };
}

function parseSummary(value: unknown): Omit<BackupRun, 'remoteKey' | 'sha256'> {
  const run = parseRun({ ...object(value), remoteKey: null, sha256: null });
  const { remoteKey: _remoteKey, sha256: _sha256, ...summary } = run;
  return summary;
}

function parsePolicy(value: unknown): BackupPolicy {
  const item = object(value);
  return {
    id: string(item.id, 'id'),
    enabled: boolean(item.enabled, 'enabled'),
    scheduleTimeLocal: string(item.scheduleTimeLocal, 'scheduleTimeLocal'),
    timezone: string(item.timezone, 'timezone'),
    dailyRetention: number(item.dailyRetention, 'dailyRetention'),
    weeklyRetention: number(item.weeklyRetention, 'weeklyRetention'),
    monthlyRetention: number(item.monthlyRetention, 'monthlyRetention'),
    defaultScope: enumValue(item.defaultScope, 'defaultScope', ['DATABASE', 'FULL_DATA'] as const),
    updatedAt: string(item.updatedAt, 'updatedAt'),
    updatedBy: nullable(item.updatedBy, 'updatedBy'),
  };
}

function parseStorage(value: unknown): BackupStorageState {
  const item = object(value);
  return {
    provider: enumValue(item.provider, 'provider', ['CLOUDFLARE_R2'] as const),
    bucketAlias: nullable(item.bucketAlias, 'bucketAlias'),
    prefix: string(item.prefix, 'prefix'),
    enabled: boolean(item.enabled, 'enabled'),
    lastConnectionTestAt: nullable(item.lastConnectionTestAt, 'lastConnectionTestAt'),
    lastConnectionTestOk: item.lastConnectionTestOk === null
      ? null : boolean(item.lastConnectionTestOk, 'lastConnectionTestOk'),
  };
}

export function parseBackupOverview(value: unknown): BackupOverview {
  const item = object(value);
  const worker = item.worker === null ? null : item.worker === undefined ? null : object(item.worker);
  return {
    lastVerifiedBackup: item.lastVerifiedBackup === null ? null : parseSummary(item.lastVerifiedBackup),
    activeRun: item.activeRun === null ? null : parseSummary(item.activeRun),
    nextScheduledAt: nullable(item.nextScheduledAt, 'nextScheduledAt'),
    scheduleTimezone: nullable(item.scheduleTimezone, 'scheduleTimezone'),
    worker: worker ? {
      workerHeartbeatAt: nullable(worker.workerHeartbeatAt, 'workerHeartbeatAt'),
      schedulerLastTickAt: nullable(worker.schedulerLastTickAt, 'schedulerLastTickAt'),
      lastScheduledFor: nullable(worker.lastScheduledFor, 'lastScheduledFor'),
    } : null,
  };
}

export function parseBackupHealth(value: unknown): BackupHealth {
  const item = object(value);
  return {
    status: enumValue(item.status, 'status', ['ok', 'unavailable'] as const),
    latestVerifiedAt: nullable(item.latestVerifiedAt, 'latestVerifiedAt'),
    latestScheduledVerifiedAt: nullable(item.latestScheduledVerifiedAt, 'latestScheduledVerifiedAt'),
    latestRunStatus: nullable(item.latestRunStatus, 'latestRunStatus'),
    latestScheduledRunStatus: nullable(item.latestScheduledRunStatus, 'latestScheduledRunStatus'),
    workerHeartbeatAt: nullable(item.workerHeartbeatAt, 'workerHeartbeatAt'),
    schedulerLastTickAt: nullable(item.schedulerLastTickAt, 'schedulerLastTickAt'),
  };
}

export async function getBackupOverview(): Promise<BackupOverview> {
  return parseBackupOverview(await request('/api/admin/backup-overview'));
}

export async function listBackups(input: { limit?: number; cursor?: string | null } = {}): Promise<BackupRunPage> {
  const params = new URLSearchParams({ limit: String(input.limit ?? 20) });
  if (input.cursor) params.set('cursor', input.cursor);
  const body = object(await request(`/api/admin/backups?${params.toString()}`));
  return {
    items: items(body).map(parseRun),
    nextCursor: nullable(body.nextCursor, 'nextCursor'),
  };
}

export async function getBackup(id: string): Promise<BackupRun> {
  return parseRun(await request(`/api/admin/backups/${encodeURIComponent(id)}`));
}

export async function requestManualBackup(input: { clientActionId: string; scope?: BackupScope }): Promise<BackupRun> {
  return parseRun(await request('/api/admin/backups', json('POST', input)));
}

export async function getBackupPolicy(): Promise<BackupPolicy> {
  return parsePolicy(await request('/api/admin/backup-policy'));
}

export async function updateBackupPolicy(input: BackupPolicyInput): Promise<BackupPolicy> {
  return parsePolicy(await request('/api/admin/backup-policy', json('PUT', input)));
}

export async function getBackupStorage(): Promise<BackupStorageState> {
  return parseStorage(await request('/api/admin/backup-storage'));
}

export async function testBackupStorage(): Promise<{ ok: boolean; testedAt: string; failureClass?: string }> {
  const item = object(await request('/api/admin/backup-storage/test', { method: 'POST' }));
  return {
    ok: boolean(item.ok, 'ok'),
    testedAt: string(item.testedAt, 'testedAt'),
    ...(item.failureClass === undefined ? {} : { failureClass: string(item.failureClass, 'failureClass') }),
  };
}

export async function getBackupHealth(): Promise<BackupHealth | null> {
  try {
    return parseBackupHealth(await request('/api/health/backup'));
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 503)) return null;
    throw error;
  }
}
