import { randomUUID } from 'node:crypto';

import type { BackupServiceTransitionPrimitives } from './service.js';
import type { BackupWorkerRepository } from './repository.js';
import { getDueScheduledSlot } from './scheduler.js';
import {
  BACKUP_RETRY_MAX_ATTEMPTS,
  isRetryableBackupFailure,
  retryDelayMs,
} from './retry.js';
import type {
  BackupFailureCode,
  BackupWorkerClaim,
} from './types.js';

export type BackupWorkerExecutionOutcome =
  | { kind: 'completed' }
  | {
    kind: 'retryable-failure';
    failureCode: BackupFailureCode;
    failureSummary: string;
  }
  | {
    kind: 'terminal-failure';
    failureCode: BackupFailureCode;
    failureSummary: string;
    /** Engines that already persisted the terminal state set this flag. */
    persisted?: boolean;
  };

export type BackupWorkerExecutionContext = {
  service: BackupServiceTransitionPrimitives;
  leaseLost: () => boolean;
};

export type BackupWorkerExecutor = (
  claim: BackupWorkerClaim,
  context: BackupWorkerExecutionContext,
) => Promise<BackupWorkerExecutionOutcome>;

export type BackupWorkerOptions = {
  repository: BackupWorkerRepository;
  service: BackupServiceTransitionPrimitives;
  executeRun: BackupWorkerExecutor;
  enabled?: boolean;
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  retryMaxAttempts?: number;
  now?: () => Date;
  sleep?: (delayMs: number) => Promise<void>;
  randomId?: () => string;
  onError?: (error: unknown) => void;
  reclaimWorkspaces?: () => Promise<void>;
};

export type BackupWorkerRunResult =
  | { kind: 'disabled' }
  | { kind: 'idle' }
  | { kind: 'scheduled'; result: 'created' | 'already-consumed' | 'blocked' }
  | { kind: 'claimed'; runId: string };

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function defaultNow(): Date {
  return new Date();
}

function boundedPositive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

/**
 * Fixed-token adapter used by every engine call in one claimed run. The
 * repository's conditional UPDATE predicates then make an expired/stolen
 * lease unable to mutate the row, even if an old worker is still unwinding.
 */
export class LeaseBoundBackupService implements BackupServiceTransitionPrimitives {
  constructor(
    private readonly service: BackupServiceTransitionPrimitives,
    private readonly leaseToken: string,
  ) {}

  startRun(id: string) {
    return this.service.startRun(id, this.leaseToken);
  }

  advancePhase(
    id: string,
    toPhase: Parameters<BackupServiceTransitionPrimitives['advancePhase']>[1],
    filesArchiveRequired: boolean,
  ) {
    return this.service.advancePhase(id, toPhase, filesArchiveRequired, this.leaseToken);
  }

  markFailed(id: string, failureCode: BackupFailureCode, failureSummary: string) {
    return this.service.markFailed(id, failureCode, failureSummary, this.leaseToken);
  }

  markCancelled(id: string) {
    return this.service.markCancelled(id, this.leaseToken);
  }

  recordVerification(id: string, input: { remoteKey: string; sizeBytes: number; sha256: string }) {
    return this.service.recordVerification(id, input, this.leaseToken);
  }

  completeRun(id: string, options?: { cleanupWarning?: string }) {
    return this.service.completeRun(id, options, this.leaseToken);
  }

  markCleanupWarning(id: string, warningSummary: string) {
    return this.service.markCleanupWarning(id, warningSummary, this.leaseToken);
  }
}

/**
 * BR5 worker runtime. `runOnce` is deliberately serialized: a scheduler tick,
 * recovery pass, and claim cannot overlap another execution in this process.
 * Multiple processes remain safe because the claim SQL uses row locks and the
 * shared backup/restore exclusion is enforced by the repository transaction.
 */
export class BackupWorker {
  private readonly enabled: boolean;
  private readonly leaseMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly retryMaxAttempts: number;
  private readonly now: () => Date;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly randomId: () => string;
  private readonly onError: (error: unknown) => void;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private stopping = false;
  private activeRun: Promise<BackupWorkerRunResult> | null = null;

  constructor(private readonly options: BackupWorkerOptions) {
    this.enabled = options.enabled ?? false;
    this.leaseMs = boundedPositive(options.leaseMs, DEFAULT_LEASE_MS, 'leaseMs');
    this.heartbeatIntervalMs = boundedPositive(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      'heartbeatIntervalMs',
    );
    if (this.heartbeatIntervalMs >= this.leaseMs) {
      throw new Error('heartbeatIntervalMs must be less than leaseMs');
    }
    this.pollIntervalMs = boundedPositive(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 'pollIntervalMs');
    this.retryMaxAttempts = boundedPositive(
      options.retryMaxAttempts,
      BACKUP_RETRY_MAX_ATTEMPTS,
      'retryMaxAttempts',
    );
    this.now = options.now ?? defaultNow;
    this.sleep = options.sleep ?? defaultSleep;
    this.randomId = options.randomId ?? randomUUID;
    this.onError = options.onError ?? (() => undefined);
  }

  /** Start the non-overlapping poll loop. Disabled workers do not touch DB. */
  start(): void {
    if (!this.enabled || this.started) return;
    this.started = true;
    this.stopping = false;
    void this.loopTick();
  }

  /** Stop accepting new work and await the currently running claim. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.activeRun;
  }

  async runOnce(): Promise<BackupWorkerRunResult> {
    if (!this.enabled || this.stopping) return { kind: 'disabled' };
    if (this.activeRun) return this.activeRun;
    const promise = this.runOnceInternal();
    this.activeRun = promise;
    try {
      return await promise;
    } finally {
      if (this.activeRun === promise) this.activeRun = null;
    }
  }

  private async loopTick(): Promise<void> {
    if (this.stopping || !this.started) return;
    try {
      await this.runOnce();
    } catch (error) {
      this.onError(error);
    }
    if (this.stopping || !this.started) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.loopTick();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  private async runOnceInternal(): Promise<BackupWorkerRunResult> {
    const { repository } = this.options;
    const tickAt = this.now();
    await repository.touchWorkerHeartbeat(tickAt);
    // A scheduler tick is liveness evidence even when another process owns
    // the shared exclusion lock. The slot is consumed only by the later
    // short enqueue transaction.
    await repository.touchSchedulerHeartbeat(tickAt);
    const result = await repository.tryWithBackupExclusionLock(async () => {
      await this.options.reclaimWorkspaces?.();
      const recovered = await repository.recoverExpiredRuns(tickAt);
      for (const recoveredRun of recovered) {
        await repository.appendSystemBackupAudit(recoveredRun.id, 'BACKUP_FAILED', {
          status: recoveredRun.status,
          phase: recoveredRun.phase,
          failureCode: recoveredRun.failureCode,
        });
      }

      const leaseToken = this.randomId();
      const leaseUntil = new Date(tickAt.getTime() + this.leaseMs);
      const cleanupClaim = await repository.claimExpiredCleanupRun(tickAt, leaseToken, leaseUntil);
      const claim = cleanupClaim ?? (await this.scheduleAndClaim(tickAt, leaseToken, leaseUntil));
      if (!claim) return { kind: 'idle' } as const;

      await repository.appendSystemBackupAudit(claim.run.id, 'BACKUP_STARTED', {
        origin: claim.run.origin,
        scope: claim.run.scope,
        retentionClass: claim.run.retentionClass,
        phase: claim.run.phase,
      });

      await this.executeClaim(claim);
      return { kind: 'claimed', runId: claim.run.id } as const;
    });
    return result ?? { kind: 'idle' };
  }

  private async scheduleAndClaim(
    now: Date,
    leaseToken: string,
    leaseUntil: Date,
  ): Promise<BackupWorkerClaim | null> {
    const { repository } = this.options;
    const policy = await repository.getPolicy();
    await repository.touchSchedulerHeartbeat(now);
    if (policy?.enabled) {
      const due = getDueScheduledSlot(now, policy.scheduleTimeLocal, policy.timezone);
      if (due) {
        const scheduled = await repository.enqueueScheduledRun({
          id: this.randomId(),
          scope: policy.defaultScope,
          retentionClass: due.retentionClass,
          createdAt: now,
          slotKey: due.slotKey,
          localDate: due.localDate,
          scheduledFor: due.scheduledFor,
        });
        if (scheduled.kind !== 'created') {
          // The slot is durably consumed (or deliberately blocked by the
          // mutex). Claiming below still lets an already queued manual run
          // make progress without a second scheduler invocation.
          const next = await repository.claimNextRun(now, leaseToken, leaseUntil);
          return next;
        }
        const next = await repository.claimNextRun(now, leaseToken, leaseUntil);
        return next;
      }
    }
    return repository.claimNextRun(now, leaseToken, leaseUntil);
  }

  private async executeClaim(claim: BackupWorkerClaim): Promise<void> {
    let leaseLost = false;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    const heartbeat = async () => {
      // Shutdown stops new claims but keeps the active lease alive until the
      // current atomic pipeline step has finished.
      if (leaseLost) return;
      try {
        const at = this.now();
        const ok = await this.options.repository.heartbeatRun(
          claim.run.id,
          claim.leaseToken,
          at,
          new Date(at.getTime() + this.leaseMs),
        );
        await this.options.repository.touchWorkerHeartbeat(at);
        if (!ok) leaseLost = true;
      } catch (error) {
        leaseLost = true;
        this.onError(error);
      }
      if (!leaseLost) {
        heartbeatTimer = setTimeout(() => {
          heartbeatTimer = null;
          void heartbeat();
        }, this.heartbeatIntervalMs);
        heartbeatTimer.unref?.();
      }
    };
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      void heartbeat();
    }, this.heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    try {
      const context: BackupWorkerExecutionContext = {
        service: new LeaseBoundBackupService(this.options.service, claim.leaseToken),
        leaseLost: () => leaseLost,
      };
      for (let attempt = 1; attempt <= this.retryMaxAttempts; attempt += 1) {
        if (leaseLost) return;
        const outcome = await this.options.executeRun(claim, context);
        if (leaseLost) return;
        if (outcome.kind === 'completed') return;
        if (outcome.kind === 'terminal-failure') {
          if (!outcome.persisted) {
            await context.service.markFailed(
              claim.run.id,
              outcome.failureCode,
              outcome.failureSummary,
            );
          }
          await this.options.repository.appendSystemBackupAudit(claim.run.id, 'BACKUP_FAILED', {
            failureCode: outcome.failureCode,
            failureSummary: outcome.failureSummary,
          });
          return;
        }
        if (!isRetryableBackupFailure(outcome.failureCode)) {
          await context.service.markFailed(
            claim.run.id,
            outcome.failureCode,
            outcome.failureSummary,
          );
          await this.options.repository.appendSystemBackupAudit(claim.run.id, 'BACKUP_FAILED', {
            failureCode: outcome.failureCode,
            failureSummary: outcome.failureSummary,
          });
          return;
        }
        if (attempt >= this.retryMaxAttempts) {
          await context.service.markFailed(
            claim.run.id,
            outcome.failureCode,
            outcome.failureSummary,
          );
          await this.options.repository.appendSystemBackupAudit(claim.run.id, 'BACKUP_FAILED', {
            failureCode: outcome.failureCode,
            failureSummary: outcome.failureSummary,
          });
          return;
        }
        await this.sleep(retryDelayMs(attempt));
      }
    } catch (error) {
      // An unexpected executor failure intentionally leaves the row RUNNING;
      // the lease expiry/recovery pass records WORKER_LOST. This preserves the
      // distinction between a classified transport failure and a crashed
      // process rather than inventing a terminal taxonomy entry.
      this.onError(error);
    } finally {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
    }
  }
}
