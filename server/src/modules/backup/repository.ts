import type { Pool, PoolClient } from 'pg';

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

const RUN_COLUMNS = `id, status, phase, origin, scope, retention_class, created_by,
  created_at, started_at, completed_at, format_version, app_version, git_commit,
  schema_version, database_server_version, dump_version, remote_key, size_bytes,
  sha256, verified_at, warning_code, warning_summary, failure_code, failure_summary`;

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
  startRun(id: string, startedAt: Date): Promise<BackupRun | null>;
  advancePhase(id: string, fromPhase: NonNullable<BackupRun['phase']>, toPhase: NonNullable<BackupRun['phase']>): Promise<BackupRun | null>;
  markFailed(id: string, failureCode: BackupFailureCode, failureSummary: string, completedAt: Date): Promise<BackupRun | null>;
  markCancelled(id: string, completedAt: Date): Promise<BackupRun | null>;
  recordVerification(id: string, input: { remoteKey: string; sizeBytes: number; sha256: string }): Promise<BackupRun | null>;
  completeRun(id: string, input: { completedAt: Date; cleanupWarning: string | null }): Promise<BackupRun | null>;
  markCleanupWarning(id: string, warningSummary: string): Promise<BackupRun | null>;
  createRestoreRun(input: CreateRestoreRunInput): Promise<RestoreRun>;
  getRestoreRunById(id: string): Promise<RestoreRun | null>;
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

export class PostgresBackupRepository implements BackupRepository {
  constructor(private readonly pool: Pool) {}

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

  async startRun(id: string, startedAt: Date) {
    const result = await this.pool.query<BackupRunRow>(
      `UPDATE backup_runs
          SET status = 'RUNNING', started_at = $2, phase = 'PREFLIGHT'
        WHERE id = $1 AND status = 'QUEUED'
        RETURNING ${RUN_COLUMNS}`,
      [id, startedAt],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async advancePhase(
    id: string,
    fromPhase: NonNullable<BackupRun['phase']>,
    toPhase: NonNullable<BackupRun['phase']>,
  ) {
    const result = await this.pool.query<BackupRunRow>(
      `UPDATE backup_runs
          SET phase = $3
        WHERE id = $1 AND status = 'RUNNING' AND phase = $2
        RETURNING ${RUN_COLUMNS}`,
      [id, fromPhase, toPhase],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async markFailed(id: string, failureCode: BackupFailureCode, failureSummary: string, completedAt: Date) {
    const result = await this.pool.query<BackupRunRow>(
      `UPDATE backup_runs
          SET status = 'FAILED', failure_code = $2, failure_summary = $3, completed_at = $4
        WHERE id = $1 AND status = 'RUNNING'
        RETURNING ${RUN_COLUMNS}`,
      [id, failureCode, failureSummary, completedAt],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async markCancelled(id: string, completedAt: Date) {
    const result = await this.pool.query<BackupRunRow>(
      `UPDATE backup_runs
          SET status = 'CANCELLED', completed_at = $2
        WHERE id = $1 AND status IN ('QUEUED', 'RUNNING')
        RETURNING ${RUN_COLUMNS}`,
      [id, completedAt],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  // REMOTE_VERIFY success: persist the verification result while the run is
  // still RUNNING. Terminalization happens only in completeRun, after CLEANUP
  // (BR0 architecture §7.2: UPLOAD → REMOTE_VERIFY → CLEANUP → SUCCESS).
  async recordVerification(id: string, input: { remoteKey: string; sizeBytes: number; sha256: string }) {
    const result = await this.pool.query<BackupRunRow>(
      `UPDATE backup_runs
          SET remote_key = $2, size_bytes = $3, sha256 = $4
        WHERE id = $1 AND status = 'RUNNING' AND phase = 'REMOTE_VERIFY'
        RETURNING ${RUN_COLUMNS}`,
      [id, input.remoteKey, input.sizeBytes, input.sha256],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  // Terminal transition after CLEANUP. verified_at is set HERE, never at
  // REMOTE_VERIFY, so the verified_at → SUCCESS invariant holds while the
  // verification result itself (sha256/remote_key/size_bytes) was already
  // recorded by recordVerification. A non-null cleanupWarning records
  // CLEANUP_FAILED without downgrading the verified restore point.
  async completeRun(id: string, input: { completedAt: Date; cleanupWarning: string | null }) {
    const warned = input.cleanupWarning !== null;
    const result = await this.pool.query<BackupRunRow>(
      `UPDATE backup_runs
          SET status = 'SUCCESS', verified_at = $2, completed_at = $2,
              warning_code = ${warned ? "'CLEANUP_FAILED'" : 'NULL'},
              warning_summary = ${warned ? '$3' : 'NULL'}
        WHERE id = $1 AND status = 'RUNNING' AND phase = 'CLEANUP'
        RETURNING ${RUN_COLUMNS}`,
      warned ? [id, input.completedAt, input.cleanupWarning] : [id, input.completedAt],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async markCleanupWarning(id: string, warningSummary: string) {
    const result = await this.pool.query<BackupRunRow>(
      `UPDATE backup_runs
          SET warning_code = 'CLEANUP_FAILED', warning_summary = $2
        WHERE id = $1 AND status = 'SUCCESS'
        RETURNING ${RUN_COLUMNS}`,
      [id, warningSummary],
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
}
