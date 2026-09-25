import { describe, expect, it, vi } from 'vitest';

import type { RecurrenceOccurrenceCreator } from '../src/modules/weekly-reports/recurrence-repository.js';
import {
  createWeeklyReportRecurrenceWorker,
  type WeeklyReportRecurrenceWorkerRepository,
} from '../src/modules/weekly-reports/recurrence-worker.js';
import type { WeeklyReportRecurrenceClaim } from '../src/modules/weekly-reports/recurrence-types.js';

const NOW = new Date('2026-10-05T09:00:00.000Z');

function claim(failureCount = 0): WeeklyReportRecurrenceClaim {
  return {
    id: 'rule-1',
    organizationId: 'org-1',
    staffUserId: 'staff-1',
    requestedByUserId: 'manager-1',
    nextPeriodStart: '2026-10-05',
    managerQuestions: [],
    instructions: null,
    failureCount,
    leaseToken: 'lease-1',
  };
}

/** Deferred promise helper for deterministic lifecycle assertions. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const noopCreate: RecurrenceOccurrenceCreator = async () => ({
  outcome: 'existing', jobCardId: 'j', reportId: 'r',
});

function fakeRepository(overrides: Partial<WeeklyReportRecurrenceWorkerRepository> = {}) {
  const calls = {
    claimDue: 0, process: 0, retry: 0, release: 0,
    retriedWith: [] as Array<{ errorCode: string; delayMs: number }>,
  };
  const repository: WeeklyReportRecurrenceWorkerRepository = {
    claimDue: async () => { calls.claimDue += 1; return []; },
    processOccurrence: async (c) => {
      calls.process += 1;
      return { result: { outcome: 'existing', recurrenceId: c.id, processedPeriodStart: c.nextPeriodStart }, realtimeEvents: [] };
    },
    retry: async (_c, now, nextAttemptAt, errorCode) => {
      calls.retry += 1;
      calls.retriedWith.push({ errorCode, delayMs: nextAttemptAt.valueOf() - now.valueOf() });
    },
    release: async () => { calls.release += 1; },
    ...overrides,
  };
  return { repository, calls };
}

describe('weekly report recurrence worker lifecycle', () => {
  it('treats an empty table as a safe no-op', async () => {
    const { repository, calls } = fakeRepository();
    const worker = createWeeklyReportRecurrenceWorker(repository, noopCreate, { now: () => NOW });
    expect(await worker.runOnce()).toBe(0);
    expect(calls.claimDue).toBe(1);
    expect(calls.process).toBe(0);
    expect(calls.release).toBe(0);
  });

  it('claims with a lease and a bounded batch, and releases on shutdown', async () => {
    const claimed: Array<{ leaseUntil: Date; limit: number }> = [];
    const { repository, calls } = fakeRepository({
      claimDue: async (_now, _token, leaseUntil, limit) => {
        claimed.push({ leaseUntil, limit });
        return [];
      },
    });
    const worker = createWeeklyReportRecurrenceWorker(repository, noopCreate, {
      now: () => NOW, leaseMs: 120_000, batchSize: 20,
    });
    await worker.runOnce();
    expect(claimed[0]!.limit).toBe(20);
    expect(claimed[0]!.leaseUntil.valueOf() - NOW.valueOf()).toBe(120_000);
    await worker.stop();
    expect(calls.release).toBe(1);
  });

  it('never runs two local iterations at once', async () => {
    const gate = deferred<void>();
    let started = 0;
    const { repository } = fakeRepository({
      claimDue: async () => {
        started += 1;
        await gate.promise;
        return [];
      },
    });
    const worker = createWeeklyReportRecurrenceWorker(repository, noopCreate, {
      now: () => NOW, pollIntervalMs: 1,
    });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The next tick is scheduled only after the current one settles, so a
    // blocked claim cannot be overlapped by another claim.
    expect(started).toBe(1);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.stop();
    expect(started).toBeGreaterThan(1);
  });

  it('is idempotent: starting twice does not create a second loop', async () => {
    const { repository, calls } = fakeRepository();
    const worker = createWeeklyReportRecurrenceWorker(repository, noopCreate, {
      now: () => NOW, pollIntervalMs: 1_000,
    });
    worker.start();
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.claimDue).toBe(1);
    await worker.stop();
  });

  it('waits for an in-flight iteration before stopping', async () => {
    const gate = deferred<void>();
    const order: string[] = [];
    const { repository } = fakeRepository({
      claimDue: async () => [claim()],
      processOccurrence: async (c) => {
        await gate.promise;
        order.push('processed');
        return { result: { outcome: 'created', recurrenceId: c.id, processedPeriodStart: c.nextPeriodStart }, realtimeEvents: [] };
      },
      release: async () => { order.push('released'); },
    });
    const worker = createWeeklyReportRecurrenceWorker(repository, noopCreate, {
      now: () => NOW, pollIntervalMs: 1_000,
    });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stopping = worker.stop();
    // The iteration is still blocked, so shutdown has not released the lease.
    expect(order).toEqual([]);
    gate.resolve();
    await stopping;
    expect(order).toEqual(['processed', 'released']);
  });

  it('contains a poll-level failure and keeps the loop alive', async () => {
    const onError = vi.fn();
    let attempts = 0;
    const { repository } = fakeRepository({
      claimDue: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('claim failed');
        return [];
      },
    });
    const worker = createWeeklyReportRecurrenceWorker(repository, noopCreate, {
      now: () => NOW, pollIntervalMs: 1, onError,
    });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await worker.stop();
    expect(onError).toHaveBeenCalled();
    expect(attempts).toBeGreaterThan(1);
  });

  it('does not crash when the error reporter itself throws', async () => {
    const { repository } = fakeRepository({
      claimDue: async () => { throw new Error('claim failed'); },
    });
    const worker = createWeeklyReportRecurrenceWorker(repository, noopCreate, {
      now: () => NOW, pollIntervalMs: 1,
      onError: () => { throw new Error('reporter failed'); },
    });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.stop();
  });

  it('retries the same period with a bounded delay on a transient failure', async () => {
    const { repository, calls } = fakeRepository({
      claimDue: async () => [claim(0)],
      processOccurrence: async () => { throw new Error('transient'); },
    });
    const worker = createWeeklyReportRecurrenceWorker(repository, noopCreate, { now: () => NOW });
    expect(await worker.runOnce()).toBe(1);
    expect(calls.retry).toBe(1);
    expect(calls.retriedWith[0]).toEqual({ errorCode: 'OCCURRENCE_FAILED', delayMs: 30_000 });
  });

  it('caps the retry backoff at one hour', async () => {
    const { repository, calls } = fakeRepository({
      claimDue: async () => [claim(50)],
      processOccurrence: async () => { throw new Error('transient'); },
    });
    const worker = createWeeklyReportRecurrenceWorker(repository, noopCreate, { now: () => NOW });
    await worker.runOnce();
    expect(calls.retriedWith[0]!.delayMs).toBe(3_600_000);
  });

  it('keeps processing the remaining claims after one fails', async () => {
    const { repository, calls } = fakeRepository({
      claimDue: async () => [claim(), { ...claim(), id: 'rule-2' }],
      processOccurrence: async (c) => {
        calls.process += 1;
        if (c.id === 'rule-1') throw new Error('transient');
        return { result: { outcome: 'created', recurrenceId: c.id, processedPeriodStart: c.nextPeriodStart }, realtimeEvents: [] };
      },
    });
    const worker = createWeeklyReportRecurrenceWorker(repository, noopCreate, { now: () => NOW });
    expect(await worker.runOnce()).toBe(2);
    expect(calls.process).toBe(2);
    expect(calls.retry).toBe(1);
  });

  it('publishes realtime only for created occurrences and only after processing', async () => {
    const published: unknown[] = [];
    const { repository } = fakeRepository({
      claimDue: async () => [claim(), { ...claim(), id: 'rule-2' }],
      processOccurrence: async (c) => ({
        result: { outcome: c.id === 'rule-1' ? 'created' : 'existing', recurrenceId: c.id, processedPeriodStart: c.nextPeriodStart },
        realtimeEvents: c.id === 'rule-1' ? [{ type: 'job.created' }] : [],
      }),
    });
    const worker = createWeeklyReportRecurrenceWorker(repository, noopCreate, {
      now: () => NOW, publisher: { publish: (event) => { published.push(event); } },
    });
    await worker.runOnce();
    expect(published).toEqual([{ type: 'job.created' }]);
  });

  it('reports bounded iteration counts without any report body', async () => {
    const reports: unknown[] = [];
    const { repository } = fakeRepository({
      claimDue: async () => [claim(), { ...claim(), id: 'rule-2' }, { ...claim(), id: 'rule-3' }],
      processOccurrence: async (c) => {
        if (c.id === 'rule-1') throw new Error('transient');
        return {
          result: {
            outcome: c.id === 'rule-2' ? 'created' : 'autoPaused',
            recurrenceId: c.id,
            processedPeriodStart: c.nextPeriodStart,
          },
          realtimeEvents: [],
        };
      },
    });
    const worker = createWeeklyReportRecurrenceWorker(repository, noopCreate, {
      now: () => NOW, onIteration: (report) => { reports.push(report); },
    });
    await worker.runOnce();
    expect(reports).toEqual([
      { claimed: 3, created: 1, existing: 0, autoPaused: 1, skipped: 0, failed: 1 },
    ]);
  });
});
