import type { Pool, PoolClient } from 'pg';

import { BACKUP_EXCLUSION_ADVISORY_LOCK_KEY } from './types.js';

import type {
  BackupAuditInput,
  BackupCriticalActionClaim,
  BackupCursor,
  BackupFailureCode,
  BackupPolicy,
  BackupPolicyUpdate,
  BackupRun,
  BackupRunDto,
  BackupRunPage,
  BackupRunPageQuery,
  BackupScope,
  BackupStorageState,
  BackupWorkerClaim,
  BackupWorkerState,
  BackupWarningCode,
  RestoreRun,
} from './types.js';

type BackupRunRow = {
  id: string;
  status: BackupRun['status'];
  phase: BackupRun['phase'];
  origin: BackupRun['origin'];
  scope: BackupRun['scope'];
  retention_class: BackupRun['retentionClass'];
  created_by: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  format_version: number;
  app_version: string | null;
  git_commit: string | null;
  schema_version: string | null;
  database_server_version: string | null;
  dump_version: number | null;
  remote_key: string | null;
  size_bytes: string | number | null;
  sha256: string | null;
  verified_at: Date | null;
  lease_until: Date | null;
  heartbeat_at: Date | null;
  warning_code: BackupWarningCode | null;
  warning_summary: string | null;
  failure_code: BackupFailureCode | null;
  failure_summary: string | null;
};

type BackupPolicyRow = {
  id: string;
  enabled: boolean;
  schedule_time_local: string;
  timezone: string;
  daily_retention: number;
  weekly_retention: number;
  monthly_retention: number;
  default_scope: BackupScope;
  updated_at: Date;
  updated_by: string | null;
};

type BackupStorageRow = {
  provider: 'CLOUDFLARE_R2';
  bucket_alias: string | null;
  prefix: string;
  enabled: boolean;
  last_connection_test_at: Date | null;
  last_connection_test_ok: boolean | null;
};

type RestoreRunRow = {
  id: string;
  backup_id: string | null;
  mode: RestoreRun['mode'];
  status: RestoreRun['status'];
  started_at: Date;
  completed_at: Date | null;
  initiated_by: string;
  target_database: string;
  pre_restore_backup_id: string | null;
  verification_result: Record<string, unknown> | null;
  failure_code: RestoreRun['failureCode'];
};

type BackupWorkerStateRow = {
  worker_heartbeat_at: Date | null;
  scheduler_last_tick_at: Date | null;
  last_scheduled_slot_key: string | null;
  last_scheduled_local_date: string | null;
  last_scheduled_for: Date | null;
  last_scheduled_run_id: string | null;
};

const RUN_COLUMNS = `id, status, phase, origin, scope, retention_class, created_by,
  created_at, started_at, completed_at, format_version, app_version, git_commit,
  schema_version, database_server_version, dump_version, remote_key, size_bytes,
  sha256, verified_at, lease_until, heartbeat_at, warning_code, warning_summary,
  failure_code, failure_summary`;

// UPDATE ... FROM statements have both the target row and a candidate CTE in
// scope. Qualify every returned column there so PostgreSQL cannot resolve
// `id` (or another shared column) ambiguously.
const RUN_COLUMNS_QUALIFIED = `r.id AS id, r.status AS status, r.phase AS phase,
  r.origin AS origin, r.scope AS scope, r.retention_class AS retention_class,
  r.created_by AS created_by, r.created_at AS created_at, r.started_at AS started_at,
  r.completed_at AS completed_at, r.format_version AS format_version,
  r.app_version AS app_version, r.git_commit AS git_commit,
  r.schema_version AS schema_version, r.database_server_version AS database_server_version,
  r.dump_version AS dump_version, r.remote_key AS remote_key, r.size_bytes AS size_bytes,
  r.sha256 AS sha256, r.verified_at AS verified_at, r.lease_until AS lease_until,
  r.heartbeat_at AS heartbeat_at, r.warning_code AS warning_code,
  r.warning_summary AS warning_summary, r.failure_code AS failure_code,
  r.failure_summary AS failure_summary`;

const POLICY_COLUMNS = `id, enabled, schedule_time_local, timezone, daily_retention,
  weekly_retention, monthly_retention, default_scope, updated_at, updated_by`;

const STORAGE_COLUMNS = `provider, bucket_alias, prefix, enabled,
  last_connection_test_at, last_connection_test_ok`;

function mapRun(row: BackupRunRow): BackupRun {
  return {
    id: row.id,
    status: row.status,
    phase: row.phase,
    origin: row.origin,
    scope: row.scope,
    retentionClass: row.retention_class,
    createdBy: row.created_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    formatVersion: row.format_version,
    appVersion: row.app_version,
    gitCommit: row.git_commit,
    schemaVersion: row.schema_version,
    databaseServerVersion: row.database_server_version,
    dumpVersion: row.dump_version,
    remoteKey: row.remote_key,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    sha256: row.sha256,
    verifiedAt: row.verified_at,
    leaseUntil: row.lease_until,
    heartbeatAt: row.heartbeat_at,
    warningCode: row.warning_code,
    warningSummary: row.warning_summary,
    failureCode: row.failure_code,
    failureSummary: row.failure_summary,
  };
}

function mapPolicy(row: BackupPolicyRow): BackupPolicy {
  return {
    id: row.id,
    enabled: row.enabled,
    scheduleTimeLocal: row.schedule_time_local,
    timezone: row.timezone,
    dailyRetention: row.daily_retention,
    weeklyRetention: row.weekly_retention,
    monthlyRetention: row.monthly_retention,
    defaultScope: row.default_scope,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function mapStorage(row: BackupStorageRow): BackupStorageState {
  return {
    provider: row.provider,
    bucketAlias: row.bucket_alias,
    prefix: row.prefix,
    enabled: row.enabled,
    lastConnectionTestAt: row.last_connection_test_at,
    lastConnectionTestOk: row.last_connection_test_ok,
  };
}

function mapWorkerState(row: BackupWorkerStateRow): BackupWorkerState {
  return {
    workerHeartbeatAt: row.worker_heartbeat_at,
    schedulerLastTickAt: row.scheduler_last_tick_at,
    lastScheduledSlotKey: row.last_scheduled_slot_key,
    lastScheduledLocalDate: row.last_scheduled_local_date,
    lastScheduledFor: row.last_scheduled_for,
    lastScheduledRunId: row.last_scheduled_run_id,
  };
}

function mapRestoreRun(row: RestoreRunRow): RestoreRun {
  return {
    id: row.id,
    backupId: row.backup_id,
    mode: row.mode,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    initiatedBy: row.initiated_by,
    targetDatabase: row.target_database,
    preRestoreBackupId: row.pre_restore_backup_id,
    verificationResult: row.verification_result,
    failureCode: row.failure_code,
  };
}

export function presentRun(run: BackupRun): BackupRunDto {
  return {
    id: run.id,
    status: run.status,
    phase: run.phase,
    origin: run.origin,
    scope: run.scope,
    retentionClass: run.retentionClass,
    createdBy: run.createdBy,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    formatVersion: run.formatVersion,
    remoteKey: run.remoteKey,
    sizeBytes: run.sizeBytes,
    sha256: run.sha256,
    verifiedAt: run.verifiedAt?.toISOString() ?? null,
    warningCode: run.warningCode,
    warningSummary: run.warningSummary,
    failureCode: run.failureCode,
    failureSummary: run.failureSummary,
  };
}

export type CreateQueuedBackupRunInput = {
  id: string;
  origin: BackupRun['origin'];
  scope: BackupScope;
  retentionClass: BackupRun['retentionClass'];
  createdBy: string | null;
  createdAt: Date;
};

export type CreateRestoreRunInput = {
  id: string;
  backupId: string | null;
  mode: RestoreRun['mode'];
  initiatedBy: string;
  targetDatabase: string;
  preRestoreBackupId: string | null;
};

export type CreateScheduledBackupRunInput = {
  id: string;
  scope: BackupScope;
  retentionClass: BackupRun['retentionClass'];
  createdAt: Date;
  slotKey: string;
  localDate: string;
  scheduledFor: Date;
};

export interface BackupTransaction {
  findActiveBackupRun(): Promise<BackupRun | null>;
  findActiveRestoreRun(): Promise<RestoreRun | null>;
  insertQueuedRun(input: CreateQueuedBackupRunInput): Promise<BackupRun>;
  updatePolicy(
    input: BackupPolicyUpdate,
    updatedBy: string | null,
    updatedAt: Date,
  ): Promise<BackupPolicy>;
  appendAudit(input: BackupAuditInput): Promise<void>;
}

export interface BackupRepository {
  execute<T>(work: (tx: BackupTransaction) => Promise<T>): Promise<T>;
  executeCriticalAction<T>(
    claim: BackupCriticalActionClaim,
    work: (tx: BackupTransaction) => Promise<T>,
  ): Promise<{ kind: 'completed'; response: T } | { kind: 'replay'; response: T } | { kind: 'processing' }>;
  findRunById(id: string): Promise<BackupRun | null>;
  listRuns(query: BackupRunPageQuery): Promise<BackupRunPage>;
  findActiveBackupRun(): Promise<BackupRun | null>;
  getPolicy(): Promise<BackupPolicy | null>;
  getStorageState(): Promise<BackupStorageState | null>;
  recordStorageConnectionTest(ok: boolean, testedAt: Date): Promise<void>;
  startRun(id: string, startedAt: Date, leaseToken?: string): Promise<BackupRun | null>;
  advancePhase(id: string, fromPhase: NonNullable<BackupRun['phase']>, toPhase: NonNullable<BackupRun['phase']>, leaseToken?: string): Promise<BackupRun | null>;
  markFailed(id: string, failureCode: BackupFailureCode, failureSummary: string, completedAt: Date, leaseToken?: string): Promise<BackupRun | null>;
  markCancelled(id: string, completedAt: Date, leaseToken?: string): Promise<BackupRun | null>;
  recordVerification(id: string, input: { remoteKey: string; sizeBytes: number; sha256: string }, leaseToken?: string): Promise<BackupRun | null>;
  completeRun(id: string, input: { completedAt: Date; cleanupWarning: string | null }, leaseToken?: string): Promise<BackupRun | null>;
  markCleanupWarning(id: string, warningSummary: string, leaseToken?: string): Promise<BackupRun | null>;
  createRestoreRun(input: CreateRestoreRunInput): Promise<RestoreRun>;
  getRestoreRunById(id: string): Promise<RestoreRun | null>;
}

export interface BackupWorkerRepository extends BackupRepository {
  tryWithBackupExclusionLock<T>(work: () => Promise<T>): Promise<T | null>;
  getWorkerState(): Promise<BackupWorkerState | null>;
  appendSystemBackupAudit(
    runId: string,
    eventType: Extract<BackupAuditInput['eventType'], 'BACKUP_STARTED' | 'BACKUP_VERIFIED' | 'BACKUP_COMPLETED' | 'BACKUP_FAILED'>,
    metadata: Record<string, unknown>,
  ): Promise<void>;
  claimNextRun(now: Date, leaseToken: string, leaseUntil: Date): Promise<BackupWorkerClaim | null>;
  claimExpiredCleanupRun(now: Date, leaseToken: string, leaseUntil: Date): Promise<BackupWorkerClaim | null>;
  recoverExpiredRuns(now: Date): Promise<BackupRun[]>;
  heartbeatRun(id: string, leaseToken: string, heartbeatAt: Date, leaseUntil: Date): Promise<boolean>;
  touchWorkerHeartbeat(at: Date): Promise<void>;
  touchSchedulerHeartbeat(at: Date): Promise<void>;
  enqueueScheduledRun(input: CreateScheduledBackupRunInput): Promise<
    | { kind: 'created'; run: BackupRun }
    | { kind: 'already-consumed' }
    | { kind: 'blocked' }
  >;
}

class PostgresBackupTransaction implements BackupTransaction {
  constructor(private readonly client: PoolClient) {}

  async findActiveBackupRun() {
    const result = await this.client.query<BackupRunRow>(
      `SELECT ${RUN_COLUMNS} FROM backup_runs
        WHERE status IN ('QUEUED', 'RUNNING')
        ORDER BY created_at DESC LIMIT 1`,
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async findActiveRestoreRun() {
    const result = await this.client.query<RestoreRunRow>(
      `SELECT id, backup_id, mode, status, started_at, completed_at, initiated_by,
              target_database, pre_restore_backup_id, verification_result, failure_code
         FROM restore_runs WHERE status = 'RUNNING' LIMIT 1`,
    );
    return result.rows[0] ? mapRestoreRun(result.rows[0]) : null;
  }

  async insertQueuedRun(input: CreateQueuedBackupRunInput) {
    const result = await this.client.query<BackupRunRow>(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class, created_by, created_at, format_version)
       VALUES ($1, 'QUEUED', $2, $3, $4, $5, $6, 1)
       RETURNING ${RUN_COLUMNS}`,
      [input.id, input.origin, input.scope, input.retentionClass, input.createdBy, input.createdAt],
    );
    return mapRun(result.rows[0]!);
  }

  async updatePolicy(input: BackupPolicyUpdate, updatedBy: string | null, updatedAt: Date) {
    const result = await this.client.query<BackupPolicyRow>(
      `UPDATE backup_policy
          SET enabled = $1, schedule_time_local = $2, timezone = $3,
              daily_retention = $4, weekly_retention = $5, monthly_retention = $6,
              default_scope = $7, updated_at = $8, updated_by = $9
        RETURNING ${POLICY_COLUMNS}`,
      [input.enabled, input.scheduleTimeLocal, input.timezone, input.dailyRetention,
        input.weeklyRetention, input.monthlyRetention, input.defaultScope, updatedAt, updatedBy],
    );
    return mapPolicy(result.rows[0]!);
  }

  async appendAudit(input: BackupAuditInput) {
    await this.client.query(
      `INSERT INTO audit_events
         (organization_id, actor_user_id, subject_type, subject_id, event_type, old_value, new_value, metadata)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6)`,
      [input.organizationId, input.actorUserId, input.subjectType, input.subjectId,
        input.eventType, JSON.stringify(input.metadata)],
    );
  }
}

export class PostgresBackupRepository implements BackupWorkerRepository {
  constructor(private readonly pool: Pool) {}

  async tryWithBackupExclusionLock<T>(work: () => Promise<T>): Promise<T | null> {
    const client = await this.pool.connect();
    let acquired = false;
    try {
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [BACKUP_EXCLUSION_ADVISORY_LOCK_KEY],
      );
      acquired = result.rows[0]?.locked === true;
      if (!acquired) return null;
      return await work();
    } finally {
      if (acquired) {
        await client.query('SELECT pg_advisory_unlock($1)', [BACKUP_EXCLUSION_ADVISORY_LOCK_KEY]);
      }
      client.release();
    }
  }

  async execute<T>(work: (tx: BackupTransaction) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PostgresBackupTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async executeCriticalAction<T>(
    claim: BackupCriticalActionClaim,
    work: (tx: BackupTransaction) => Promise<T>,
  ): Promise<{ kind: 'completed'; response: T } | { kind: 'replay'; response: T } | { kind: 'processing' }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query<{ id: string }>(
        `INSERT INTO processed_actions
           (organization_id, user_id, client_action_id, operation_key, status)
         VALUES ($1, $2, $3, $4, 'processing')
         ON CONFLICT (organization_id, user_id, client_action_id, operation_key) DO NOTHING
         RETURNING id`,
        [claim.organizationId, claim.userId, claim.clientActionId, claim.operationKey],
      );

      if (claimed.rowCount === 0) {
        const existing = await client.query<{ status: string; response_body: T | null }>(
          `SELECT status, response_body FROM processed_actions
            WHERE organization_id = $1 AND user_id = $2
              AND client_action_id = $3 AND operation_key = $4`,
          [claim.organizationId, claim.userId, claim.clientActionId, claim.operationKey],
        );
        await client.query('COMMIT');
        const action = existing.rows[0];
        if (action?.status === 'completed' && action.response_body !== null) {
          return { kind: 'replay', response: action.response_body };
        }
        return { kind: 'processing' };
      }

      const response = await work(new PostgresBackupTransaction(client));
      await client.query(
        `UPDATE processed_actions
          SET status = 'completed', status_code = 202, response_body = $2, completed_at = NOW()
         WHERE id = $1`,
        [claimed.rows[0]!.id, JSON.stringify(response)],
      );
      await client.query('COMMIT');
      return { kind: 'completed', response };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findRunById(id: string) {
    const result = await this.pool.query<BackupRunRow>(
      `SELECT ${RUN_COLUMNS} FROM backup_runs WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async listRuns(query: BackupRunPageQuery) {
    const cursorClause = query.cursor ? 'WHERE (created_at, id) < ($1, $2)' : '';
    const values = query.cursor
      ? [query.cursor.createdAt, query.cursor.id, query.limit + 1]
      : [query.limit + 1];
    const limitParameter = query.cursor ? '$3' : '$1';
    const result = await this.pool.query<BackupRunRow>(
      `SELECT ${RUN_COLUMNS} FROM backup_runs
        ${cursorClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limitParameter}`,
      values,
    );
    const rows = result.rows.slice(0, query.limit);
    const last = rows.at(-1);
    const nextCursor: BackupCursor | null = result.rows.length > query.limit && last
      ? { createdAt: last.created_at, id: last.id }
      : null;
    return { items: rows.map(mapRun), nextCursor };
  }

  async findActiveBackupRun() {
    const result = await this.pool.query<BackupRunRow>(
      `SELECT ${RUN_COLUMNS} FROM backup_runs
        WHERE status IN ('QUEUED', 'RUNNING')
        ORDER BY created_at DESC LIMIT 1`,
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async getPolicy() {
    const result = await this.pool.query<BackupPolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM backup_policy LIMIT 1`,
    );
    return result.rows[0] ? mapPolicy(result.rows[0]) : null;
  }

  async recordStorageConnectionTest(ok: boolean, testedAt: Date): Promise<void> {
    const result = await this.pool.query(
      `UPDATE backup_storage
          SET last_connection_test_at = $1, last_connection_test_ok = $2
        WHERE singleton
        RETURNING id`,
      [testedAt, ok],
    );
    if (result.rowCount !== 1) {
      throw new Error('backup storage singleton is unavailable');
    }
  }

  async getStorageState() {
    const result = await this.pool.query<BackupStorageRow>(
      `SELECT ${STORAGE_COLUMNS} FROM backup_storage LIMIT 1`,
    );
    return result.rows[0] ? mapStorage(result.rows[0]) : null;
  }

  async getWorkerState() {
    const result = await this.pool.query<BackupWorkerStateRow>(
      `SELECT worker_heartbeat_at, scheduler_last_tick_at,
              last_scheduled_slot_key, last_scheduled_local_date,
              last_scheduled_for, last_scheduled_run_id
         FROM backup_worker_state
        WHERE singleton
        LIMIT 1`,
    );
    return result.rows[0] ? mapWorkerState(result.rows[0]) : null;
  }

  async appendSystemBackupAudit(
    runId: string,
    eventType: Extract<BackupAuditInput['eventType'], 'BACKUP_STARTED' | 'BACKUP_VERIFIED' | 'BACKUP_COMPLETED' | 'BACKUP_FAILED'>,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events
        (organization_id, actor_user_id, subject_type, subject_id, event_type, metadata)
       SELECT NULL, NULL, 'BACKUP_RUN', $1, $2::varchar, $3
        WHERE NOT EXISTS (
          SELECT 1 FROM audit_events
           WHERE subject_type = 'BACKUP_RUN' AND subject_id = $1 AND event_type = $2::varchar
        )`,
      [runId, eventType, JSON.stringify({ ...metadata, actorType: 'SYSTEM', backupId: runId })],
    );
  }

  async startRun(id: string, startedAt: Date, leaseToken?: string) {
    const result = await this.pool.query<BackupRunRow>(
      `UPDATE backup_runs
          SET status = 'RUNNING', started_at = $2, phase = 'PREFLIGHT'
        WHERE id = $1 AND status = 'QUEUED'
          AND ($3::uuid IS NULL OR lease_token = $3)
        RETURNING ${RUN_COLUMNS}`,
      [id, startedAt, leaseToken ?? null],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async advancePhase(
    id: string,
    fromPhase: NonNullable<BackupRun['phase']>,
    toPhase: NonNullable<BackupRun['phase']>,
    leaseToken?: string,
  ) {
    const result = await this.pool.query<BackupRunRow>(
      `UPDATE backup_runs
          SET phase = $3
        WHERE id = $1 AND status = 'RUNNING' AND phase = $2
          AND ($4::uuid IS NULL OR lease_token = $4)
        RETURNING ${RUN_COLUMNS}`,
      [id, fromPhase, toPhase, leaseToken ?? null],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async markFailed(id: string, failureCode: BackupFailureCode, failureSummary: string, completedAt: Date, leaseToken?: string) {
    const result = await this.pool.query<BackupRunRow>(
      `UPDATE backup_runs
          SET status = 'FAILED', failure_code = $2, failure_summary = $3, completed_at = $4,
              lease_token = NULL, lease_until = NULL, heartbeat_at = NULL
        WHERE id = $1 AND status = 'RUNNING'
          AND ($5::uuid IS NULL OR lease_token = $5)
        RETURNING ${RUN_COLUMNS}`,
      [id, failureCode, failureSummary, completedAt, leaseToken ?? null],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async markCancelled(id: string, completedAt: Date, leaseToken?: string) {
    const result = await this.pool.query<BackupRunRow>(
      `UPDATE backup_runs
          SET status = 'CANCELLED', completed_at = $2,
              lease_token = NULL, lease_until = NULL, heartbeat_at = NULL
        WHERE id = $1 AND status IN ('QUEUED', 'RUNNING')
          AND ($3::uuid IS NULL OR lease_token = $3)
        RETURNING ${RUN_COLUMNS}`,
      [id, completedAt, leaseToken ?? null],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  // REMOTE_VERIFY success: persist the verification result while the run is
  // still RUNNING. Terminalization happens only in completeRun, after CLEANUP
  // (BR0 architecture §7.2: UPLOAD → REMOTE_VERIFY → CLEANUP → SUCCESS).
  async recordVerification(id: string, input: { remoteKey: string; sizeBytes: number; sha256: string }, leaseToken?: string) {
    const result = await this.pool.query<BackupRunRow>(
      `UPDATE backup_runs
          SET remote_key = $2, size_bytes = $3, sha256 = $4
        WHERE id = $1 AND status = 'RUNNING' AND phase = 'REMOTE_VERIFY'
          AND $3::bigint > 0
          AND ($5::uuid IS NULL OR lease_token = $5)
        RETURNING ${RUN_COLUMNS}`,
      [id, input.remoteKey, input.sizeBytes, input.sha256, leaseToken ?? null],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  // Terminal transition after CLEANUP. verified_at is set HERE, never at
  // REMOTE_VERIFY, so the verified_at → SUCCESS invariant holds while the
  // verification result itself (sha256/remote_key/size_bytes) was already
  // recorded by recordVerification. A non-null cleanupWarning records
  // CLEANUP_FAILED without downgrading the verified restore point.
  async completeRun(id: string, input: { completedAt: Date; cleanupWarning: string | null }, leaseToken?: string) {
    const result = await this.pool.query<BackupRunRow>(
      `UPDATE backup_runs
          SET status = 'SUCCESS', verified_at = $2, completed_at = $2,
              warning_code = CASE WHEN $3::text IS NULL THEN NULL ELSE 'CLEANUP_FAILED' END,
              warning_summary = $3,
              lease_token = NULL, lease_until = NULL, heartbeat_at = NULL
        WHERE id = $1 AND status = 'RUNNING' AND phase = 'CLEANUP'
          AND remote_key IS NOT NULL AND remote_key <> ''
          AND size_bytes > 0
          AND sha256 ~ '^[0-9a-f]{64}$'
          AND ($4::uuid IS NULL OR lease_token = $4)
        RETURNING ${RUN_COLUMNS}`,
      [id, input.completedAt, input.cleanupWarning, leaseToken ?? null],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async markCleanupWarning(id: string, warningSummary: string, leaseToken?: string) {
    const result = await this.pool.query<BackupRunRow>(
      `UPDATE backup_runs
          SET warning_code = 'CLEANUP_FAILED', warning_summary = $2
        WHERE id = $1 AND status = 'SUCCESS'
          AND ($3::uuid IS NULL OR lease_token = $3)
        RETURNING ${RUN_COLUMNS}`,
      [id, warningSummary, leaseToken ?? null],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async createRestoreRun(input: CreateRestoreRunInput) {
    const result = await this.pool.query<RestoreRunRow>(
      `INSERT INTO restore_runs
         (id, backup_id, mode, status, initiated_by, target_database, pre_restore_backup_id)
       VALUES ($1, $2, $3, 'RUNNING', $4, $5, $6)
       RETURNING id, backup_id, mode, status, started_at, completed_at, initiated_by,
                 target_database, pre_restore_backup_id, verification_result, failure_code`,
      [input.id, input.backupId, input.mode, input.initiatedBy, input.targetDatabase, input.preRestoreBackupId],
    );
    return mapRestoreRun(result.rows[0]!);
  }

  async getRestoreRunById(id: string) {
    const result = await this.pool.query<RestoreRunRow>(
      `SELECT id, backup_id, mode, status, started_at, completed_at, initiated_by,
              target_database, pre_restore_backup_id, verification_result, failure_code
         FROM restore_runs WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapRestoreRun(result.rows[0]) : null;
  }

  async claimNextRun(now: Date, leaseToken: string, leaseUntil: Date): Promise<BackupWorkerClaim | null> {
    const leaseDurationMs = Math.max(1, leaseUntil.getTime() - now.getTime());
    const result = await this.pool.query<BackupRunRow>(
      `WITH candidate AS (
         SELECT id
           FROM backup_runs
          WHERE status = 'QUEUED'
          ORDER BY created_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE backup_runs r
          SET status = 'RUNNING', phase = 'PREFLIGHT', started_at = CURRENT_TIMESTAMP,
              lease_token = $1,
              lease_until = CURRENT_TIMESTAMP + ($2::bigint * INTERVAL '1 millisecond'),
              heartbeat_at = CURRENT_TIMESTAMP
         FROM candidate
        WHERE r.id = candidate.id
        RETURNING ${RUN_COLUMNS_QUALIFIED}`,
      [leaseToken, leaseDurationMs],
    );
    const row = result.rows[0];
    return row ? { run: mapRun(row), leaseToken, leaseUntil } : null;
  }

  async claimExpiredCleanupRun(now: Date, leaseToken: string, leaseUntil: Date): Promise<BackupWorkerClaim | null> {
    const leaseDurationMs = Math.max(1, leaseUntil.getTime() - now.getTime());
    const result = await this.pool.query<BackupRunRow>(
      `WITH candidate AS (
         SELECT id
           FROM backup_runs
          WHERE status = 'RUNNING'
            AND phase = 'CLEANUP'
            -- BR4 rows created before worker adoption have no lease; once BR5
            -- is the only executor, a null lease is an immediately stale
            -- ownership record and may enter the same proof-gated recovery.
            AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP)
            AND verified_at IS NULL
            AND completed_at IS NULL
            AND failure_code IS NULL
            AND remote_key IS NOT NULL
            AND remote_key <> ''
            AND size_bytes > 0
            AND sha256 IS NOT NULL
            AND sha256 ~ '^[0-9a-f]{64}$'
          ORDER BY lease_until ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE backup_runs r
          SET lease_token = $1,
              lease_until = CURRENT_TIMESTAMP + ($2::bigint * INTERVAL '1 millisecond'),
              heartbeat_at = CURRENT_TIMESTAMP
         FROM candidate
        WHERE r.id = candidate.id
        RETURNING ${RUN_COLUMNS_QUALIFIED}`,
      [leaseToken, leaseDurationMs],
    );
    const row = result.rows[0];
    return row ? { run: mapRun(row), leaseToken, leaseUntil } : null;
  }

  async recoverExpiredRuns(_now: Date): Promise<BackupRun[]> {
    const result = await this.pool.query<BackupRunRow>(
      `WITH expired AS (
         SELECT id
           FROM backup_runs
          WHERE status = 'RUNNING'
            -- A pre-BR5 RUNNING row has no ownership timestamp. Treat it as
            -- stale rather than leaving it permanently orphaned.
            AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP)
            AND NOT (
              phase = 'CLEANUP'
              AND verified_at IS NULL
              AND completed_at IS NULL
              AND failure_code IS NULL
              AND remote_key IS NOT NULL
              AND remote_key <> ''
              AND size_bytes > 0
              AND sha256 IS NOT NULL
              AND sha256 ~ '^[0-9a-f]{64}$'
            )
          FOR UPDATE SKIP LOCKED
       )
       UPDATE backup_runs r
          SET status = 'FAILED', failure_code = 'WORKER_LOST',
              failure_summary = 'Backup worker lease expired before durable remote verification.',
              completed_at = CURRENT_TIMESTAMP, lease_token = NULL, lease_until = NULL,
              heartbeat_at = NULL
         FROM expired
        WHERE r.id = expired.id
        RETURNING ${RUN_COLUMNS_QUALIFIED}`,
      [],
    );
    return result.rows.map(mapRun);
  }

  async heartbeatRun(id: string, leaseToken: string, heartbeatAt: Date, leaseUntil: Date): Promise<boolean> {
    const leaseDurationMs = Math.max(1, leaseUntil.getTime() - heartbeatAt.getTime());
    const result = await this.pool.query(
      `UPDATE backup_runs
          SET heartbeat_at = CURRENT_TIMESTAMP,
              lease_until = CURRENT_TIMESTAMP + ($3::bigint * INTERVAL '1 millisecond')
        WHERE id = $1 AND status = 'RUNNING' AND lease_token = $2
          AND lease_until > CURRENT_TIMESTAMP`,
      [id, leaseToken, leaseDurationMs],
    );
    return result.rowCount === 1;
  }

  async touchWorkerHeartbeat(_at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE backup_worker_state SET worker_heartbeat_at = CURRENT_TIMESTAMP WHERE singleton`,
    );
  }

  async touchSchedulerHeartbeat(_at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE backup_worker_state SET scheduler_last_tick_at = CURRENT_TIMESTAMP WHERE singleton`,
    );
  }

  async enqueueScheduledRun(input: CreateScheduledBackupRunInput) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const state = await client.query<BackupWorkerStateRow>(
        `SELECT worker_heartbeat_at, scheduler_last_tick_at,
                last_scheduled_slot_key, last_scheduled_local_date,
                last_scheduled_for, last_scheduled_run_id
           FROM backup_worker_state
          WHERE singleton
          FOR UPDATE`,
      );
      const current = state.rows[0];
      if (!current) throw new Error('backup worker state singleton is unavailable');
      if (
        current.last_scheduled_slot_key === input.slotKey
        // A policy timezone change must not create a second run for the same
        // local calendar day. The scheduler is at-most-once per local day.
        || current.last_scheduled_local_date === input.localDate
      ) {
        await client.query(
          `UPDATE backup_worker_state SET scheduler_last_tick_at = CURRENT_TIMESTAMP WHERE singleton`,
        );
        await client.query('COMMIT');
        return { kind: 'already-consumed' as const };
      }

      const active = await client.query<{ id: string }>(
        `SELECT id FROM backup_runs WHERE status IN ('QUEUED', 'RUNNING') LIMIT 1`,
      );
      const restore = await client.query<{ id: string }>(
        `SELECT id FROM restore_runs WHERE status = 'RUNNING' LIMIT 1`,
      );
      if (active.rowCount || restore.rowCount) {
        await client.query(
          `UPDATE backup_worker_state SET scheduler_last_tick_at = CURRENT_TIMESTAMP WHERE singleton`,
        );
        await client.query('COMMIT');
        return { kind: 'blocked' as const };
      }

      const inserted = await client.query<BackupRunRow>(
        `INSERT INTO backup_runs
          (id, status, phase, origin, scope, retention_class, created_by, created_at, format_version)
         VALUES ($1, 'QUEUED', NULL, 'SCHEDULED', $2, $3, NULL, $4, 1)
         RETURNING ${RUN_COLUMNS}`,
        [input.id, input.scope, input.retentionClass, input.createdAt],
      );
      const run = mapRun(inserted.rows[0]!);
      await client.query(
        `INSERT INTO audit_events
          (organization_id, actor_user_id, subject_type, subject_id, event_type, metadata)
         VALUES (NULL, NULL, 'BACKUP_RUN', $1, 'BACKUP_REQUESTED', $2)`,
        [run.id, JSON.stringify({
          backupId: run.id,
          scope: run.scope,
          origin: run.origin,
          retentionClass: run.retentionClass,
          status: run.status,
          actorType: 'SYSTEM',
          scheduledSlot: input.slotKey,
        })],
      );
      await client.query(
        `UPDATE backup_worker_state
            SET scheduler_last_tick_at = CURRENT_TIMESTAMP,
                last_scheduled_slot_key = $1,
                last_scheduled_local_date = $2::date,
                last_scheduled_for = $3,
                last_scheduled_run_id = $4
          WHERE singleton`,
        [input.slotKey, input.localDate, input.scheduledFor, run.id],
      );
      await client.query('COMMIT');
      return { kind: 'created' as const, run };
    } catch (error) {
      await client.query('ROLLBACK');
      if (
        typeof error === 'object' && error !== null
        && (error as { code?: string; constraint?: string }).code === '23505'
        && (error as { constraint?: string }).constraint === 'backup_runs_single_active_unique'
      ) {
        return { kind: 'blocked' as const };
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
