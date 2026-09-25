import { randomUUID } from 'node:crypto';

import {
  NOOP_REALTIME_EVENT_PUBLISHER,
  type RealtimeEventPublisher,
} from '../realtime/event-bus.js';
import type { PostgresWeeklyReportRecurrenceRepository } from './recurrence-repository.js';
import type { RecurrenceOccurrenceCreator } from './recurrence-repository.js';
import type {
  WeeklyReportRecurrenceClaim,
  WeeklyReportRecurrenceOccurrenceResult,
} from './recurrence-types.js';

/**
 * Weekly Report recurrence worker (V1 Slice 5).
 *
 * Mirrors the calendar reminder worker's process-lifecycle discipline
 * (bounded poll loop, lease token, lease-expiry recovery, `FOR UPDATE SKIP
 * LOCKED` claiming, no overlapping local iteration, `start()/stop()/runOnce()`,
 * safe shutdown) but NOT its table: the recurrence table has its own claim,
 * occurrence and advancement semantics.
 *
 * Design differences from the calendar reminder worker, all deliberate:
 * - There is NO abandonment. A transient failure must not silently drop a
 *   week, so the same period is retried with capped backoff indefinitely.
 * - Exactly ONE period is processed per claim. A rule that is several weeks
 *   behind catches up sequentially across successive iterations instead of
 *   jumping to the current week.
 */

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000] as const;

export type WeeklyReportRecurrenceIterationReport = Readonly<{
  claimed: number;
  created: number;
  existing: number;
  autoPaused: number;
  skipped: number;
  failed: number;
}>;

export type WeeklyReportRecurrenceWorkerRepository = Pick<
  PostgresWeeklyReportRecurrenceRepository,
  'claimDue' | 'retry' | 'release'
> & {
  processOccurrence(
    claim: WeeklyReportRecurrenceClaim,
    now: Date,
    create: RecurrenceOccurrenceCreator,
  ): Promise<{
    result: WeeklyReportRecurrenceOccurrenceResult;
    realtimeEvents: readonly import('../realtime/types.js').RealtimeEventRecord[];
  }>;
};

export type WeeklyReportRecurrenceWorker = Readonly<{
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<number>;
}>;

export function createWeeklyReportRecurrenceWorker(
  repository: WeeklyReportRecurrenceWorkerRepository,
  create: RecurrenceOccurrenceCreator,
  options: Readonly<{
    now?: () => Date;
    publisher?: RealtimeEventPublisher;
    pollIntervalMs?: number;
    leaseMs?: number;
    batchSize?: number;
    onError?: (error: unknown) => void;
    onIteration?: (report: WeeklyReportRecurrenceIterationReport) => void;
  }> = {},
): WeeklyReportRecurrenceWorker {
  const now = options.now ?? (() => new Date());
  const publisher = options.publisher ?? NOOP_REALTIME_EVENT_PUBLISHER;
  const pollIntervalMs = options.pollIntervalMs ?? 60_000;
  const leaseMs = options.leaseMs ?? 120_000;
  const batchSize = options.batchSize ?? 20;
  const leaseToken = randomUUID();
  let timer: NodeJS.Timeout | null = null;
  let active: Promise<number> | null = null;

  // Reporting must never crash the worker: a throwing reporter is contained.
  const reportError = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // best-effort reporting only
    }
  };

  const reportIteration = (report: WeeklyReportRecurrenceIterationReport) => {
    try {
      options.onIteration?.(report);
    } catch {
      // best-effort reporting only
    }
  };

  const runOnce = async () => {
    const claimedAt = now();
    const claims = await repository.claimDue(
      claimedAt,
      leaseToken,
      new Date(claimedAt.valueOf() + leaseMs),
      batchSize,
    );
    let created = 0;
    let existing = 0;
    let autoPaused = 0;
    let skipped = 0;
    let failed = 0;
    for (const claim of claims) {
      try {
        const { result, realtimeEvents } = await repository.processOccurrence(claim, now(), create);
        switch (result.outcome) {
          case 'created': created += 1; break;
          case 'existing': existing += 1; break;
          case 'autoPaused': autoPaused += 1; break;
          case 'skipped': skipped += 1; break;
        }
        // Realtime is published only AFTER the occurrence transaction commits.
        // A crash between commit and publication is safe: the database is
        // authoritative and the schedule already advanced, so the retry path
        // cannot create a second report.
        for (const event of realtimeEvents) publisher.publish(event);
      } catch {
        // Transient failure: DO NOT advance the period. Release the lease and
        // retry the SAME period with bounded, capped backoff.
        const failedAt = now();
        try {
          const delay = RETRY_DELAYS_MS[
            Math.min(claim.failureCount, RETRY_DELAYS_MS.length - 1)
          ]!;
          await repository.retry(
            claim,
            failedAt,
            new Date(failedAt.valueOf() + delay),
            'OCCURRENCE_FAILED',
          );
        } catch (bookkeepingError) {
          // The claim stays leased, so lease expiry reclaims it. Report and
          // continue with the remaining claims instead of rejecting runOnce.
          reportError(bookkeepingError);
        }
        failed += 1;
      }
    }
    reportIteration({
      claimed: claims.length, created, existing, autoPaused, skipped, failed,
    });
    return claims.length;
  };

  return {
    start() {
      if (timer) return;
      const tick = () => {
        // Contain poll-level failures (e.g. claimDue): report and keep the loop
        // alive. Without this catch the rejected promise assigned to `active`
        // escapes as an unhandled rejection and can crash the process.
        active = runOnce().catch((error: unknown) => {
          reportError(error);
          return 0;
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
      // Wait for an in-flight iteration instead of cutting a transaction mid-write.
      await active;
      await repository.release(leaseToken, now());
    },
    runOnce,
  };
}
