import { randomUUID } from 'node:crypto';

import { AppError } from '../../errors/index.js';
import type { SafeUser } from '../auth/types.js';
import { presentRun, type BackupRepository } from './repository.js';
import type {
  BackupOverviewDto,
  BackupFailureCode,
  BackupPolicy,
  BackupPolicyUpdate,
  BackupRun,
  BackupRunPage,
  BackupRunPageQuery,
  BackupRunDto,
  BackupScope,
  BackupStorageState,
  BackupWorkerState,
} from './types.js';
import { getNextScheduledSlot } from './scheduler.js';
import {
  isValidPhaseTransition as phaseTransitionValid,
  isValidStatusTransition as statusTransitionValid,
} from './types.js';

const forbidden = () => new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz yok.');
const actionInProgress = () => new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
const backupRunActive = () => new AppError('BACKUP_RUN_ACTIVE', 409, 'Zaten aktif bir yedek çalışması var.');
const restoreInProgress = () => new AppError('RESTORE_IN_PROGRESS', 409, 'Devam eden bir geri yükleme çalışması var.');
const invalidTransition = () => new AppError('BACKUP_INVALID_TRANSITION', 409, 'Yedek çalışması bu durumdan bu duruma geçirilemez.');
const backupNotFound = () => new AppError('BACKUP_NOT_FOUND', 404, 'Yedek kaydı bulunamadı.');
const policyUnavailable = () => new AppError('BACKUP_POLICY_UNAVAILABLE', 500, 'Yedekleme politikası kullanılamıyor.');
const storageUnavailable = () => new AppError('BACKUP_STORAGE_UNAVAILABLE', 500, 'Yedekleme depolama yapılandırması kullanılamıyor.');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function validation(field: string) {
  const message = `${field} geçersizdir.`;
  return new AppError('VALIDATION_ERROR', 400, message, { fieldErrors: { [field]: message } });
}

function codePointLength(value: string) {
  return Array.from(value).length;
}

function boundedTrimmedString(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string') throw validation(field);
  const trimmed = value.trim();
  const length = codePointLength(trimmed);
  if (length < min || length > max) throw validation(field);
  return trimmed;
}

function requireActionId(value: unknown) {
  return boundedTrimmedString(value, 'clientActionId', 1, 255);
}

export function requireAdmin(actor: SafeUser) {
  if (actor.role !== 'ADMIN') throw forbidden();
}

export function requireBackupRunId(value: string) {
  const trimmed = value.trim();
  if (!UUID_PATTERN.test(trimmed)) throw backupNotFound();
  return trimmed;
}

function scopeValue(value: unknown, field: string): BackupScope {
  if (value !== 'DATABASE' && value !== 'FULL_DATA') throw validation(field);
  return value;
}

function validTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

const SINGLE_ACTIVE_CONSTRAINT = 'backup_runs_single_active_unique';

function isSingleActiveViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: string; constraint?: string }).code === '23505'
    && (error as { constraint?: string }).constraint === SINGLE_ACTIVE_CONSTRAINT;
}

export type BackupStorageProbeResult =
  | { ok: true }
  | { ok: false; errorClass: 'CONFIG' | 'AUTH' | 'TRANSPORT' | 'SERVICE' | 'UNKNOWN' };

/** Lazy storage probe built by the app wiring (real R2 adapter when fully
 * configured, CONFIG-class otherwise). The service never sees credentials. */
export type BackupStorageProbe = () => Promise<BackupStorageProbeResult>;

export type BackupStorageRuntimeState = Pick<
  BackupStorageState,
  'bucketAlias' | 'prefix' | 'enabled'
>;

export type ManualBackupRequestInput = {
  clientActionId: unknown;
  scope?: unknown;
};

export type BackupServiceTransitionPrimitives = {
  startRun(id: string, leaseToken?: string): Promise<BackupRun>;
  advancePhase(id: string, toPhase: NonNullable<BackupRun['phase']>, filesArchiveRequired: boolean, leaseToken?: string): Promise<BackupRun>;
  markFailed(id: string, failureCode: BackupFailureCode, failureSummary: string, leaseToken?: string): Promise<BackupRun>;
  markCancelled(id: string, leaseToken?: string): Promise<BackupRun>;
  recordVerification(id: string, input: { remoteKey: string; sizeBytes: number; sha256: string }, leaseToken?: string): Promise<BackupRun>;
  completeRun(id: string, options?: { cleanupWarning?: string }, leaseToken?: string): Promise<BackupRun>;
  markCleanupWarning(id: string, warningSummary: string, leaseToken?: string): Promise<BackupRun>;
};

export class BackupService implements BackupServiceTransitionPrimitives {
  constructor(
    private readonly repository: BackupRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly storageRuntimeState: BackupStorageRuntimeState | null = null,
  ) {}

  async requestManualBackup(actor: SafeUser, input: ManualBackupRequestInput) {
    requireAdmin(actor);
    const clientActionId = requireActionId(input.clientActionId);
    const scope = input.scope === undefined ? await this.defaultScope() : scopeValue(input.scope, 'scope');

    try {
      const result = await this.repository.executeCriticalAction(
        {
          organizationId: actor.organizationId,
          userId: actor.id,
          clientActionId,
          operationKey: 'BACKUP_MANUAL_CREATE',
        },
        async (tx) => {
          const activeRestore = await tx.findActiveRestoreRun();
          if (activeRestore) throw restoreInProgress();
          const activeRun = await tx.findActiveBackupRun();
          if (activeRun) throw backupRunActive();

          const run = await tx.insertQueuedRun({
            id: randomUUID(),
            origin: 'MANUAL',
            scope,
            retentionClass: 'MANUAL',
            createdBy: actor.id,
            createdAt: this.now(),
          });
          await tx.appendAudit({
            organizationId: actor.organizationId,
            actorUserId: actor.id,
            subjectType: 'BACKUP_RUN',
            subjectId: run.id,
            eventType: 'BACKUP_REQUESTED',
            metadata: {
              backupId: run.id,
              scope,
              origin: 'MANUAL',
              retentionClass: 'MANUAL',
              status: 'QUEUED',
            },
          });
          return presentRun(run);
        },
      );
      if (result.kind === 'processing') throw actionInProgress();
      return result.response;
    } catch (error) {
      // The partial unique index is the race-free guard; the pre-check above is
      // only for a clean conflict response. Two concurrent requests land here.
      if (isSingleActiveViolation(error)) throw backupRunActive();
      throw error;
    }
  }

  async listRuns(actor: SafeUser, query: BackupRunPageQuery): Promise<{ items: BackupRunDto[]; nextCursor: BackupRunPage['nextCursor'] }> {
    requireAdmin(actor);
    const page = await this.repository.listRuns(query);
    return { items: page.items.map(presentRun), nextCursor: page.nextCursor };
  }

  async getRun(actor: SafeUser, id: string) {
    requireAdmin(actor);
    const run = await this.repository.findRunById(requireBackupRunId(id));
    if (!run) throw backupNotFound();
    return presentRun(run);
  }

  async getOverview(actor: SafeUser): Promise<BackupOverviewDto> {
    requireAdmin(actor);
    const policy = await this.repository.getPolicy();
    if (!policy) throw policyUnavailable();
    const [activeRun, latestVerifiedRun, workerState] = await Promise.all([
      this.repository.findActiveBackupRun(),
      this.repository.findLatestVerifiedRun
        ? this.repository.findLatestVerifiedRun()
        : this.repository.listRuns({ limit: 50, cursor: null }).then((page) =>
          page.items.find((run) => run.status === 'SUCCESS' && run.verifiedAt !== null) ?? null),
      this.repository.getWorkerState ? this.repository.getWorkerState() : Promise.resolve(null),
    ]);

    let nextScheduledAt: string | null = null;
    if (policy.enabled) {
      try {
        nextScheduledAt = getNextScheduledSlot(
          this.now(), policy.scheduleTimeLocal, policy.timezone,
        ).scheduledFor.toISOString();
      } catch {
        // A policy persisted by an older deployment must fail closed in the
        // projection; policy validation remains owned by the service.
        nextScheduledAt = null;
      }
    }

    return {
      lastVerifiedBackup: latestVerifiedRun ? presentSummary(latestVerifiedRun) : null,
      activeRun: activeRun ? presentSummary(activeRun) : null,
      nextScheduledAt,
      scheduleTimezone: policy.timezone,
      worker: workerState ? presentWorkerState(workerState) : null,
    };
  }

  async getPolicy(actor: SafeUser): Promise<BackupPolicy> {
    requireAdmin(actor);
    const policy = await this.repository.getPolicy();
    if (!policy) throw policyUnavailable();
    return policy;
  }

  async updatePolicy(actor: SafeUser, input: BackupPolicyUpdate): Promise<BackupPolicy> {
    requireAdmin(actor);
    const normalized = normalizePolicyUpdate(input);
    return this.repository.execute(async (tx) => {
      const updated = await tx.updatePolicy(normalized, actor.id, this.now());
      await tx.appendAudit({
        organizationId: actor.organizationId,
        actorUserId: actor.id,
        subjectType: 'BACKUP_POLICY',
        subjectId: policySubjectId(updated),
        eventType: 'BACKUP_POLICY_UPDATED',
        metadata: {
          enabled: updated.enabled,
          scheduleTimeLocal: updated.scheduleTimeLocal,
          timezone: updated.timezone,
          dailyRetention: updated.dailyRetention,
          weeklyRetention: updated.weeklyRetention,
          monthlyRetention: updated.monthlyRetention,
          defaultScope: updated.defaultScope,
        },
      });
      return updated;
    });
  }

  async getStorageState(actor: SafeUser): Promise<BackupStorageState> {
    requireAdmin(actor);
    const state = await this.repository.getStorageState();
    if (!state) throw storageUnavailable();
    return this.storageRuntimeState ? { ...state, ...this.storageRuntimeState } : state;
  }

  /**
   * BR4 storage connection test: short synchronous connectivity + capability
   * probe (list + create/abort multipart on a reserved key), ADMIN only.
   * Persists only the safe timestamp/outcome on the backup_storage singleton.
   * Never echoes credentials or raw SDK errors.
   */
  async testStorageConnection(actor: SafeUser, probe: BackupStorageProbe): Promise<{
    ok: boolean;
    testedAt: string;
    failureClass: 'CONFIG' | 'AUTH' | 'TRANSPORT' | 'SERVICE' | 'UNKNOWN' | undefined;
  }> {
    requireAdmin(actor);
    const testedAt = this.now();
    let result: BackupStorageProbeResult;
    try {
      result = await probe();
    } catch {
      // A probe implementation must normally classify its own failures, but
      // unexpected adapter/wiring errors still persist a truthful failed test
      // without exposing raw diagnostics through the HTTP response.
      result = { ok: false, errorClass: 'UNKNOWN' };
    }
    await this.repository.recordStorageConnectionTest(result.ok, testedAt);
    return {
      ok: result.ok,
      testedAt: testedAt.toISOString(),
      failureClass: result.ok ? undefined : result.errorClass,
    };
  }

  private async defaultScope(): Promise<BackupScope> {
    const policy = await this.repository.getPolicy();
    return policy?.defaultScope ?? 'DATABASE';
  }

  // -------------------------------------------------------------------------
  // Domain transition primitives (BR5 worker contract; BR1 exercises them in
  // tests only). Every mutation goes through the state machine — there is no
  // generic updateBackupRun(fields) surface.
  // -------------------------------------------------------------------------

  async startRun(id: string, leaseToken?: string): Promise<BackupRun> {
    const run = await this.requireRun(id);
    if (!statusTransitionValid(run.status, 'RUNNING')) throw invalidTransition();
    const updated = await this.repository.startRun(id, this.now(), leaseToken);
    if (!updated) throw invalidTransition();
    return updated;
  }

  async advancePhase(id: string, toPhase: NonNullable<BackupRun['phase']>, filesArchiveRequired: boolean, leaseToken?: string): Promise<BackupRun> {
    const run = await this.requireRun(id);
    if (run.status !== 'RUNNING' || run.phase === null) throw invalidTransition();
    if (!phaseTransitionValid(run.phase, toPhase, { filesArchiveRequired })) throw invalidTransition();
    const updated = await this.repository.advancePhase(id, run.phase, toPhase, leaseToken);
    if (!updated) throw invalidTransition();
    return updated;
  }

  async markFailed(id: string, failureCode: BackupFailureCode, failureSummary: string, leaseToken?: string): Promise<BackupRun> {
    const run = await this.requireRun(id);
    if (!statusTransitionValid(run.status, 'FAILED')) throw invalidTransition();
    const updated = await this.repository.markFailed(id, failureCode, boundedTrimmedString(failureSummary, 'failureSummary', 1, 500), this.now(), leaseToken);
    if (!updated) throw invalidTransition();
    return updated;
  }

  async markCancelled(id: string, leaseToken?: string): Promise<BackupRun> {
    const run = await this.requireRun(id);
    if (!statusTransitionValid(run.status, 'CANCELLED')) throw invalidTransition();
    const updated = await this.repository.markCancelled(id, this.now(), leaseToken);
    if (!updated) throw invalidTransition();
    return updated;
  }

  // REMOTE_VERIFY success: persist verification evidence without terminalizing.
  // The run stays RUNNING; only completeRun (after CLEANUP) may reach SUCCESS.
  async recordVerification(id: string, input: { remoteKey: string; sizeBytes: number; sha256: string }, leaseToken?: string): Promise<BackupRun> {
    const run = await this.requireRun(id);
    if (run.status !== 'RUNNING' || run.phase !== 'REMOTE_VERIFY') throw invalidTransition();
    const remoteKey = boundedTrimmedString(input.remoteKey, 'remoteKey', 1, 500);
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) throw validation('sizeBytes');
    const sha256 = input.sha256.trim().toLowerCase();
    if (!SHA256_PATTERN.test(sha256)) throw validation('sha256');
    const updated = await this.repository.recordVerification(id, { remoteKey, sizeBytes: input.sizeBytes, sha256 }, leaseToken);
    if (!updated) throw invalidTransition();
    return updated;
  }

  // Terminal transition after CLEANUP: verification evidence must already
  // exist (recordVerification). A cleanup warning records CLEANUP_FAILED on a
  // fully verified SUCCESS run and never downgrades it to a failure.
  async completeRun(id: string, options: { cleanupWarning?: string } = {}, leaseToken?: string): Promise<BackupRun> {
    const run = await this.requireRun(id);
    if (run.status !== 'RUNNING' || run.phase !== 'CLEANUP') throw invalidTransition();
    if (
      run.remoteKey === null
      || run.remoteKey.trim().length === 0
      || run.sizeBytes === null
      || run.sizeBytes <= 0
      || run.sha256 === null
      || !SHA256_PATTERN.test(run.sha256)
      || run.failureCode !== null
    ) throw invalidTransition();
    const cleanupWarning = options.cleanupWarning === undefined
      ? null
      : boundedTrimmedString(options.cleanupWarning, 'cleanupWarning', 1, 500);
    const updated = await this.repository.completeRun(id, { completedAt: this.now(), cleanupWarning }, leaseToken);
    if (!updated) throw invalidTransition();
    return updated;
  }

  async markCleanupWarning(id: string, warningSummary: string, leaseToken?: string): Promise<BackupRun> {
    const run = await this.requireRun(id);
    if (run.status !== 'SUCCESS') throw invalidTransition();
    const updated = await this.repository.markCleanupWarning(id, boundedTrimmedString(warningSummary, 'warningSummary', 1, 500), leaseToken);
    if (!updated) throw invalidTransition();
    return updated;
  }

  private async requireRun(id: string): Promise<BackupRun> {
    const run = await this.repository.findRunById(requireBackupRunId(id));
    if (!run) throw backupNotFound();
    return run;
  }
}

function presentSummary(run: BackupRun): BackupOverviewDto['activeRun'] {
  const { remoteKey: _remoteKey, sha256: _sha256, ...summary } = presentRun(run);
  return summary;
}

function presentWorkerState(state: BackupWorkerState): NonNullable<BackupOverviewDto['worker']> {
  return {
    workerHeartbeatAt: state.workerHeartbeatAt?.toISOString() ?? null,
    schedulerLastTickAt: state.schedulerLastTickAt?.toISOString() ?? null,
    lastScheduledFor: state.lastScheduledFor?.toISOString() ?? null,
  };
}

function policySubjectId(policy: BackupPolicy): string {
  return policy.id;
}

function normalizePolicyUpdate(input: BackupPolicyUpdate): BackupPolicyUpdate {
  const scheduleTimeLocal = input.scheduleTimeLocal.trim();
  if (!TIME_PATTERN.test(scheduleTimeLocal)) throw validation('scheduleTimeLocal');
  const timezone = input.timezone.trim();
  if (timezone.length === 0 || timezone.length > 64 || !validTimezone(timezone)) throw validation('timezone');
  for (const [field, value, min, max] of [
    ['dailyRetention', input.dailyRetention, 1, 365],
    ['weeklyRetention', input.weeklyRetention, 1, 52],
    ['monthlyRetention', input.monthlyRetention, 1, 120],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw validation(field);
  }
  scopeValue(input.defaultScope, 'defaultScope');
  if (typeof input.enabled !== 'boolean') throw validation('enabled');
  return { ...input, scheduleTimeLocal, timezone };
}
