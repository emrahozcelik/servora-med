/**
 * OVR-3: clock-only overdue breach scanner.
 *
 * OVR-1 answers "which job is currently overdue". OVR-2 persists a breach when
 * a *request* observes or causes it (TRANSITION / MUTATION). Neither covers the
 * case this module owns: an already-existing, provable obligation becoming late
 * **solely because time passes**, with no lifecycle mutation at all. A job that
 * was accepted inside its window and simply never started would otherwise stay
 * invisible in incident history forever.
 *
 * Scope (deliberately narrow):
 * - it does not define a new overdue condition, change lifecycle state, invent
 *   historical evidence, decide recovery, or rewrite OVR-2 breach arithmetic;
 * - it discovers currently open, provable obligations whose first-late boundary
 *   has passed and materializes them through the *shared* producer, so the
 *   clock-only path cannot drift from the request-driven one;
 * - it never writes recovery. A later lifecycle action recovers the incident
 *   through the existing OVR-2 contract.
 *
 * ---------------------------------------------------------------------------
 * Request-time ordering (the reason this scanner is not a plain SELECT→INSERT)
 * ---------------------------------------------------------------------------
 * 049 linearized lifecycle business time: `reserved_at` is sampled from the
 * arbitration clock *under the JobCard lock*, and the request's business time is
 * that instant — never lock-wait, provider or commit time. So a START accepted
 * at 09:59:59 against a 10:00:00 end is on time even if the provider answers at
 * 10:00:01.
 *
 * That creates a real race for any clock-only scanner:
 *
 *   1. START reserves (business time 09:59:59) and releases the JobCard lock
 *      while its provider work is still running;
 *   2. the boundary passes at 10:00:00;
 *   3. the scanner locks the still-ACCEPTED job and would write LATE_START;
 *   4. START finalizes with its earlier business time and recovers the incident
 *      with `recovered_at` *before* `breached_at`.
 *
 * The result would be history that contradicts itself, and a breach that never
 * happened. A row lock or UNIQUE constraint cannot fix it, and neither can
 * `recovered_at = max(requestTime, breached_at)` — that only hides a false
 * breach behind a plausible timestamp.
 *
 * The mechanism therefore reuses the durable state 049 already introduced
 * instead of adding a parallel one: a live `PENDING` lifecycle reservation
 * whose `reserved_at` is strictly before the delay type's first-late boundary
 * is durable evidence that a valid lifecycle request was accepted *inside* the
 * boundary and is still in flight. This scanner must not contradict it, so it
 * skips the delay type for that job. No grace period, no lease, no claim table,
 * no DB-clock domain decision.
 *
 * The wait is bounded by construction: `expires_at` (reserved_at + TTL) is the
 * point after which finalize can never commit, so once the reservation expires
 * the breach becomes materializable again — and it is a real breach then,
 * because the request provably failed to land inside its budget.
 */

import {
  DISCHARGING_COMMANDS_BY_DELAY_TYPE,
  OVERDUE_INCIDENT_DELAY_TYPES,
  type OverdueIncidentDelayType,
} from './overdue-incidents.js';
import type { OverdueScanCandidate, JobCardRepository } from './repository.js';
import {
  commitOverdueBreachPlan,
  planApprovalWaitBreach,
  planLateStartBreach,
  planLateSubmissionBreach,
  type OverdueBreachPlan,
  type OverdueBreachUnprovableReason,
} from './overdue-breach-producer.js';
import type { JobCardTransaction } from './repository.js';
import type { JobCard } from './types.js';

/** Result of evaluating one discovered candidate. */
export type OverdueScanCandidateOutcome =
  | { kind: 'inserted' }
  | { kind: 'converged' }
  | { kind: 'skipped-not-breached' }
  | { kind: 'skipped-incomplete-evidence'; reason: OverdueBreachUnprovableReason }
  | { kind: 'skipped-state-changed' }
  | { kind: 'skipped-in-flight-request' };

/** Bounded operational visibility for one scanner iteration. */
export type OverdueScanIterationReport = {
  scanTime: string;
  candidates: number;
  inserted: number;
  converged: number;
  skippedNotBreached: number;
  skippedIncompleteEvidence: number;
  skippedStateChanged: number;
  skippedInFlightRequest: number;
  failed: number;
  byDelayType: Readonly<Record<OverdueIncidentDelayType, number>>;
};

/**
 * Candidate discovery is a prefilter only; the outcome of a candidate is always
 * decided inside `scanCandidate`'s transaction.
 */
export interface OverdueBreachScannerRepository {
  listCandidates(input: {
    delayType: OverdueIncidentDelayType;
    scanTime: Date;
    limit: number;
  }): Promise<readonly OverdueScanCandidate[]>;
  scanCandidate(input: {
    delayType: OverdueIncidentDelayType;
    candidate: OverdueScanCandidate;
    scanTime: Date;
  }): Promise<OverdueScanCandidateOutcome>;
}

/** Which delay type the job's current state makes the scanner eligible for. */
function isEligibleStatus(delayType: OverdueIncidentDelayType, job: JobCard): boolean {
  switch (delayType) {
    // NEW is deliberately excluded: an unaccepted assignment is not yet a
    // clock-only obligation — its lateness belongs to its lifecycle producer
    // (a late ACCEPT_ASSIGNMENT), not to time passing.
    case 'LATE_START': return job.status === 'ACCEPTED';
    case 'LATE_SUBMISSION':
      return job.status === 'IN_PROGRESS' || job.status === 'REVISION_REQUESTED';
    case 'APPROVAL_WAIT': return job.status === 'WAITING_APPROVAL';
  }
}

export class PostgresOverdueBreachScannerRepository
implements OverdueBreachScannerRepository {
  constructor(private readonly repository: JobCardRepository) {}

  listCandidates(input: {
    delayType: OverdueIncidentDelayType;
    scanTime: Date;
    limit: number;
  }) {
    return this.repository.listOverdueBreachCandidates(input);
  }

  /**
   * Re-evaluate one candidate transactionally and materialize at most one
   * incident. Everything that decides the outcome is re-read under the JobCard
   * row lock in this transaction: lifecycle state, the governing revision,
   * episode activation / facts, and the in-flight lifecycle reservations. A
   * candidate that changed under the lock is skipped, never written from the
   * stale discovery read.
   */
  scanCandidate(input: {
    delayType: OverdueIncidentDelayType;
    candidate: OverdueScanCandidate;
    scanTime: Date;
  }): Promise<OverdueScanCandidateOutcome> {
    const { organizationId, jobCardId } = input.candidate;
    return this.repository.executeTransaction(async (tx) => {
      const job = await tx.getJobForUpdate(organizationId, jobCardId);
      if (job === null || !isEligibleStatus(input.delayType, job)) {
        return { kind: 'skipped-state-changed' };
      }
      const scope = { organizationId, jobCardId };
      const plan = await planBreach(tx, input.delayType, job, scope, input.scanTime);
      if (plan.kind === 'unprovable') {
        return { kind: 'skipped-incomplete-evidence', reason: plan.reason };
      }
      if (plan.kind === 'not-breached') return { kind: 'skipped-not-breached' };
      // Request-time ordering guard: a lifecycle request accepted strictly
      // inside this delay type's first-late boundary and still in flight is
      // authoritative over clock-only discovery for this obligation.
      const inFlight = (await tx.listLiveLifecycleIntents(organizationId, jobCardId, {
        reservedBefore: plan.boundaryAt,
        atTime: input.scanTime,
      })).some((intent) =>
        DISCHARGING_COMMANDS_BY_DELAY_TYPE[input.delayType].includes(intent.command),
      );
      if (inFlight) return { kind: 'skipped-in-flight-request' };
      const evaluation = await commitOverdueBreachPlan(tx, plan);
      if (evaluation.kind !== 'breached') return { kind: 'skipped-not-breached' };
      return evaluation.created ? { kind: 'inserted' } : { kind: 'converged' };
    });
  }
}

function planBreach(
  tx: JobCardTransaction,
  delayType: OverdueIncidentDelayType,
  job: JobCard,
  scope: { organizationId: string; jobCardId: string },
  scanTime: Date,
): Promise<OverdueBreachPlan> {
  switch (delayType) {
    case 'LATE_START':
      return planLateStartBreach(tx, {
        ...scope,
        scheduledEndsAt: job.scheduledEndsAt,
        scheduleRevisionNo: null,
        revisionEffectiveAt: null,
        source: 'SCANNER',
        requestTime: scanTime,
      });
    case 'LATE_SUBMISSION':
      // Same job-lock discipline as the request-driven producer: the sequence
      // read here and any later SUBMITTED fact observe the same MAX.
      return tx.getNextSubmittedSeqNo(scope.organizationId, scope.jobCardId).then(
        (episodeNo) => planLateSubmissionBreach(tx, {
          ...scope,
          scheduledEndsAt: job.scheduledEndsAt,
          scheduledAt: job.scheduledAt,
          type: job.type,
          dueDate: job.dueDate,
          episodeNo,
          scheduleRevisionNo: null,
          revisionEffectiveAt: null,
          source: 'SCANNER',
          requestTime: scanTime,
        }),
      );
    case 'APPROVAL_WAIT':
      return planApprovalWaitBreach(tx, {
        ...scope,
        source: 'SCANNER',
        requestTime: scanTime,
      });
  }
}

export type OverdueBreachScanner = Readonly<{
  start(): void;
  stop(): Promise<void>;
  runOnce(scanTime: Date): Promise<OverdueScanIterationReport>;
}>;

/**
 * Bounded, non-overlapping scanner loop following the calendar reminder worker
 * conventions. Deliberately no distributed lease/claim layer: the incident
 * UNIQUE identity plus the per-candidate JobCard row lock already make two
 * concurrent workers converge on one durable incident.
 */
export function createOverdueBreachScanner(
  repository: OverdueBreachScannerRepository,
  options: Readonly<{
    now?: () => Date;
    pollIntervalMs?: number;
    batchSize?: number;
    onReport?: (report: OverdueScanIterationReport) => void;
    onError?: (error: unknown) => void;
  }> = {},
): OverdueBreachScanner {
  const now = options.now ?? (() => new Date());
  const pollIntervalMs = options.pollIntervalMs ?? 60_000;
  const batchSize = options.batchSize ?? 50;
  let timer: NodeJS.Timeout | null = null;
  let active: Promise<OverdueScanIterationReport> | null = null;

  // Reporting must never crash the worker: a throwing reporter is contained.
  const report = (reportValue: OverdueScanIterationReport) => {
    try {
      options.onReport?.(reportValue);
    } catch {
      // best-effort reporting only
    }
  };
  const reportError = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // best-effort reporting only
    }
  };

  const runOnce = async (scanTime: Date): Promise<OverdueScanIterationReport> => {
    const byDelayType = Object.fromEntries(
      OVERDUE_INCIDENT_DELAY_TYPES.map((delayType) => [delayType, 0]),
    ) as Record<OverdueIncidentDelayType, number>;
    const counts = {
      candidates: 0,
      inserted: 0,
      converged: 0,
      skippedNotBreached: 0,
      skippedIncompleteEvidence: 0,
      skippedStateChanged: 0,
      skippedInFlightRequest: 0,
      failed: 0,
    };
    for (const delayType of OVERDUE_INCIDENT_DELAY_TYPES) {
      const candidates = await repository.listCandidates({ delayType, scanTime, limit: batchSize });
      for (const candidate of candidates) {
        counts.candidates += 1;
        byDelayType[delayType] += 1;
        try {
          const outcome = await repository.scanCandidate({ delayType, candidate, scanTime });
          switch (outcome.kind) {
            case 'inserted': counts.inserted += 1; break;
            case 'converged': counts.converged += 1; break;
            case 'skipped-not-breached': counts.skippedNotBreached += 1; break;
            case 'skipped-incomplete-evidence': counts.skippedIncompleteEvidence += 1; break;
            case 'skipped-state-changed': counts.skippedStateChanged += 1; break;
            case 'skipped-in-flight-request': counts.skippedInFlightRequest += 1; break;
          }
        } catch (error) {
          // One failing candidate must not abort the iteration or starve the
          // remaining candidates; it is retried on a later tick.
          counts.failed += 1;
          reportError(error);
        }
      }
    }
    const result: OverdueScanIterationReport = {
      scanTime: scanTime.toISOString(),
      ...counts,
      byDelayType,
    };
    report(result);
    return result;
  };

  return {
    start() {
      if (timer) return;
      const tick = () => {
        // Contain tick-level failures (e.g. discovery): report and keep the
        // loop alive instead of escaping as an unhandled rejection.
        active = runOnce(now()).catch((error: unknown) => {
          reportError(error);
          return runOnceFailedReport(now());
        }).finally(() => {
          active = null;
          if (timer) timer = setTimeout(tick, pollIntervalMs);
        });
      };
      timer = setTimeout(tick, 0);
    },
    async stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      await active;
    },
    runOnce,
  };
}

/** Explicit not-run report so a failed tick is never mistaken for a clean one. */
function runOnceFailedReport(scanTime: Date): OverdueScanIterationReport {
  return {
    scanTime: scanTime.toISOString(),
    candidates: 0,
    inserted: 0,
    converged: 0,
    skippedNotBreached: 0,
    skippedIncompleteEvidence: 0,
    skippedStateChanged: 0,
    skippedInFlightRequest: 0,
    failed: 1,
    byDelayType: Object.fromEntries(
      OVERDUE_INCIDENT_DELAY_TYPES.map((delayType) => [delayType, 0]),
    ) as Record<OverdueIncidentDelayType, number>,
  };
}
