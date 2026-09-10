import { describe, expect, it, vi } from 'vitest';

import {
  createCalendarReminderWorker,
  type CalendarReminderClaim,
  type CalendarReminderWorkerRepository,
} from '../src/modules/calendar/reminder-worker.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { createDispatcher } from '../src/modules/web-push/dispatcher.js';
import { createWorkerStopHandler } from '../src/shutdown.js';

/**
 * B4 worker rejection boundaries.
 *
 * These tests are intentionally free of sleeps and fake timers: every wait is
 * event-driven (a deferred promise resolved by the worker callback under
 * test) with a watchdog timeout that only fires when the code is broken.
 */

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function captureUnhandled() {
  const errors: unknown[] = [];
  const listener = (reason: unknown) => {
    errors.push(reason);
  };
  process.on('unhandledRejection', listener);
  return {
    errors,
    dispose: () => {
      process.removeListener('unhandledRejection', listener);
    },
  };
}

// ── Calendar reminder worker ──────────────────────────────────────────────

const REMINDER_ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REMINDER_USER = '22222222-2222-4222-8222-222222222222';
const REMINDER_EVENT = '33333333-3333-4333-8333-333333333333';

function reminderClaim(id: string, attemptCount = 1): CalendarReminderClaim {
  return {
    id,
    organizationId: REMINDER_ORG,
    recipientUserId: REMINDER_USER,
    jobCardId: null,
    calendarEventId: REMINDER_EVENT,
    attemptCount,
    leaseToken: '44444444-4444-4444-8444-444444444444',
  };
}

function reminderEvent(id: string): RealtimeEventRecord {
  return {
    id: 1n,
    organizationId: REMINDER_ORG,
    sourceActivityId: null,
    type: 'calendar.reminder_due',
    entityType: 'calendar-event',
    entityId: id,
    actorUserId: null,
    audience: { roles: [], userIds: [REMINDER_USER] },
    resourceKeys: ['calendar', 'notifications'],
    occurredAt: new Date('2026-07-26T08:30:00.000Z'),
  } as RealtimeEventRecord;
}

const FIXED_NOW = () => new Date('2026-07-26T08:30:00.000Z');

describe('calendar reminder worker rejection boundaries', () => {
  it('contains per-claim bookkeeping failures without aborting the batch', async () => {
    const capture = captureUnhandled();
    try {
      const claimA = reminderClaim('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
      const claimB = reminderClaim('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2');
      const project = vi.fn(async (claim: CalendarReminderClaim) => {
        if (claim.id === claimA.id) throw new Error('project boom');
        return reminderEvent(claim.id);
      });
      const retry = vi.fn(async () => {
        throw new Error('retry boom');
      });
      const abandon = vi.fn(async () => undefined);
      const repo = {
        claimDue: vi.fn(async () => [claimA, claimB]),
        project,
        retry,
        abandon,
        release: vi.fn(async () => undefined),
      } satisfies CalendarReminderWorkerRepository;

      const errors: unknown[] = [];
      const published: RealtimeEventRecord[] = [];
      const worker = createCalendarReminderWorker(repo, {
        now: FIXED_NOW,
        publisher: {
          publish: (event) => {
            published.push(event);
          },
        },
        onError: (error) => {
          errors.push(error);
        },
      });

      // Previously the failing retry() rejected runOnce, which escaped from
      // the poll tick as an unhandled rejection and aborted the batch.
      await expect(worker.runOnce()).resolves.toBe(2);

      // Both claims were attempted; the second one is unaffected.
      expect(project).toHaveBeenCalledTimes(2);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(abandon).not.toHaveBeenCalled();
      expect(published).toHaveLength(1);
      expect(published[0]!.entityId).toBe(claimB.id);

      // The bookkeeping failure is still observable instead of silent.
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe('retry boom');

      await flush();
      expect(capture.errors).toEqual([]);
    } finally {
      capture.dispose();
    }
  });

  it('keeps the poll loop alive across claim failures and recovers', async () => {
    const capture = captureUnhandled();
    const claim = reminderClaim('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3');
    let claimCalls = 0;
    const errors: unknown[] = [];
    let errorsResolve: (() => void) | null = null;
    const twoErrors = new Promise<void>((resolve) => {
      errorsResolve = resolve;
    });
    const published: RealtimeEventRecord[] = [];
    let publishResolve: (() => void) | null = null;
    const publishedOnce = new Promise<void>((resolve) => {
      publishResolve = resolve;
    });
    const repo = {
      claimDue: vi.fn(async () => {
        claimCalls += 1;
        if (claimCalls <= 2) throw new Error('db down');
        return [claim];
      }),
      project: vi.fn(async () => reminderEvent(claim.id)),
      retry: vi.fn(async () => undefined),
      abandon: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    } satisfies CalendarReminderWorkerRepository;
    const worker = createCalendarReminderWorker(repo, {
      now: FIXED_NOW,
      publisher: {
        publish: (event) => {
          published.push(event);
          publishResolve?.();
        },
      },
      pollIntervalMs: 5,
      onError: (error) => {
        errors.push(error);
        if (errors.length >= 2) errorsResolve?.();
      },
    });

    worker.start();
    try {
      await withTimeout(twoErrors, 5000, 'tick failures reported');
      expect(errors.map((error) => (error as Error).message)).toEqual([
        'db down',
        'db down',
      ]);

      // The loop survived: the next poll claims and projects successfully.
      await withTimeout(publishedOnce, 5000, 'recovered reminder published');
      expect(claimCalls).toBeGreaterThanOrEqual(3);
      expect(published.length).toBeGreaterThanOrEqual(1);
    } finally {
      await worker.stop();
    }

    expect(repo.release).toHaveBeenCalledTimes(1);
    await flush();
    expect(capture.errors).toEqual([]);
    capture.dispose();
  });

  it('tolerates a throwing error reporter without unhandled rejections', async () => {
    const capture = captureUnhandled();
    const claim = reminderClaim('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4');
    let claimCalls = 0;
    const published: RealtimeEventRecord[] = [];
    let publishResolve: (() => void) | null = null;
    const publishedOnce = new Promise<void>((resolve) => {
      publishResolve = resolve;
    });
    const repo = {
      claimDue: vi.fn(async () => {
        claimCalls += 1;
        if (claimCalls === 1) throw new Error('db down');
        return [claim];
      }),
      project: vi.fn(async () => reminderEvent(claim.id)),
      retry: vi.fn(async () => undefined),
      abandon: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    } satisfies CalendarReminderWorkerRepository;
    const worker = createCalendarReminderWorker(repo, {
      now: FIXED_NOW,
      publisher: {
        publish: (event) => {
          published.push(event);
          publishResolve?.();
        },
      },
      pollIntervalMs: 5,
      onError: () => {
        throw new Error('reporter boom');
      },
    });

    worker.start();
    try {
      await withTimeout(publishedOnce, 5000, 'reminder published despite throwing reporter');
    } finally {
      await worker.stop();
    }

    await flush();
    expect(capture.errors).toEqual([]);
    capture.dispose();
  });
});

// ── Web-push dispatcher ───────────────────────────────────────────────────

function pushDelivery(deliveryId = 'del-1') {
  return {
    deliveryId,
    leaseToken: 'tok-1',
    attemptCount: 1,
    notification: {
      id: 'notif-1',
      organizationId: 'org-1',
      recipientUserId: 'user-1',
      kind: 'job.assigned',
      entityType: 'job-card',
      entityId: '00000000-0000-0000-0000-000000000001',
      createdAt: new Date('2026-07-22T10:00:00.000Z'),
      readAt: null,
    },
    subscription: {
      id: 'sub-1',
      endpoint: 'https://fcm.googleapis.com/fcm/send/test',
      p256dh: 'test-p256dh',
      auth: 'test-auth',
    },
  };
}

function pushPayload() {
  return {
    version: 1 as const,
    notificationId: 'notif-1',
    title: 'Test',
    body: 'Test body',
    url: '/jobs/1',
  };
}

describe('web-push dispatcher rejection boundaries', () => {
  it('contains lifecycle-lock failures without unhandled rejections or fake outcomes', async () => {
    const capture = captureUnhandled();
    const errors: unknown[] = [];
    let errorResolve: (() => void) | null = null;
    const errorReported = new Promise<void>((resolve) => {
      errorResolve = resolve;
    });
    const repository = {
      cleanupDueDeliveries: vi.fn(async () => 0),
      claimDueDeliveries: vi.fn(async () => [pushDelivery()]),
      withDeliveryLifecycleLock: vi.fn(async () => {
        throw new Error('lock boom');
      }),
      recordDelivered: vi.fn(async () => true),
      recordRetry: vi.fn(async () => true),
      recordAbandoned: vi.fn(async () => true),
      recordProviderStale: vi.fn(async () => true),
    };
    const sender = {
      send: vi.fn(async () => ({ type: 'response' as const, statusCode: 201 })),
    };
    const dispatcher = createDispatcher({ pollIntervalMs: 5, gracePeriodMs: 200 }, {
      repository,
      sender,
      buildPayload: () => pushPayload(),
      topicBuilder: () => 'topic-1',
      onError: (error) => {
        errors.push(error);
        errorResolve?.();
      },
    });

    // Previously the rejected withDeliveryLifecycleLock promise escaped from
    // the fire-and-forget processDelivery as an unhandled rejection.
    dispatcher.start();
    try {
      await withTimeout(errorReported, 5000, 'delivery failure reported');
    } finally {
      await dispatcher.stop();
    }

    // The lock failed before any provider call: nothing was recorded, so the
    // failure cannot look like a success, and the lease expiry pass reclaims it.
    expect(sender.send).not.toHaveBeenCalled();
    expect(repository.recordDelivered).not.toHaveBeenCalled();
    expect(repository.recordRetry).not.toHaveBeenCalled();
    expect(repository.recordAbandoned).not.toHaveBeenCalled();
    expect(repository.recordProviderStale).not.toHaveBeenCalled();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as Error).message).toBe('lock boom');

    await flush();
    expect(capture.errors).toEqual([]);
    capture.dispose();
  });

  it('contains provider send failures and keeps delivering afterwards', async () => {
    const capture = captureUnhandled();
    const errors: unknown[] = [];
    let errorResolve: (() => void) | null = null;
    const errorReported = new Promise<void>((resolve) => {
      errorResolve = resolve;
    });
    let deliveredResolve: (() => void) | null = null;
    const deliveredOnce = new Promise<void>((resolve) => {
      deliveredResolve = resolve;
    });
    const recordDelivered = vi.fn(async () => {
      deliveredResolve?.();
      return true;
    });
    const guard = {
      eligible: true,
      recordDelivered,
      recordRetry: vi.fn(async () => true),
      recordAbandoned: vi.fn(async () => true),
      recordProviderStale: vi.fn(async () => true),
    };
    const repository = {
      cleanupDueDeliveries: vi.fn(async () => 0),
      claimDueDeliveries: vi.fn(async () => [pushDelivery()]),
      withDeliveryLifecycleLock: vi.fn(async (_delivery: unknown, _at: unknown, work: (guard: typeof guard) => Promise<void>) => work(guard)),
      recordDelivered,
      recordRetry: guard.recordRetry,
      recordAbandoned: guard.recordAbandoned,
      recordProviderStale: guard.recordProviderStale,
    };
    let failSend = true;
    const sender = {
      send: vi.fn(async () => {
        if (failSend) throw new Error('provider boom');
        return { type: 'response' as const, statusCode: 201 };
      }),
    };
    const dispatcher = createDispatcher({ pollIntervalMs: 5, gracePeriodMs: 200 }, {
      repository,
      sender,
      buildPayload: () => pushPayload(),
      topicBuilder: () => 'topic-1',
      onError: (error) => {
        errors.push(error);
        errorResolve?.();
      },
    });

    dispatcher.start();
    try {
      await withTimeout(errorReported, 5000, 'send failure reported');
      expect((errors[0] as Error).message).toBe('provider boom');
      expect(recordDelivered).not.toHaveBeenCalled();

      // One failed push does not crash the worker: the next delivery succeeds.
      failSend = false;
      await withTimeout(deliveredOnce, 5000, 'later delivery recorded');
      expect(recordDelivered).toHaveBeenCalled();
      expect(guard.recordAbandoned).not.toHaveBeenCalled();
    } finally {
      await dispatcher.stop();
    }

    await flush();
    expect(capture.errors).toEqual([]);
    capture.dispose();
  });
});

// ── Backup worker shutdown boundary ───────────────────────────────────────

describe('backup worker stop handler', () => {
  it('reports stop failures but still runs shutdown sequencing exactly once', async () => {
    const capture = captureUnhandled();
    try {
      const stopError = new Error('stop boom');
      const stop = vi.fn(async () => {
        throw stopError;
      });
      let stoppedCalls = 0;
      let stoppedResolve: (() => void) | null = null;
      const stopped = new Promise<void>((resolve) => {
        stoppedResolve = resolve;
      });
      const errors: unknown[] = [];
      // Previously `void worker.stop().finally(...)` let a stop rejection
      // escape as an unhandled rejection from the signal handler.
      const requestStop = createWorkerStopHandler({
        stop,
        onStopped: () => {
          stoppedCalls += 1;
          stoppedResolve?.();
        },
        onError: (error) => {
          errors.push(error);
        },
      });

      requestStop();
      requestStop();
      expect(stop).toHaveBeenCalledTimes(1);

      await withTimeout(stopped, 5000, 'shutdown sequencing');
      expect(stoppedCalls).toBe(1);
      expect(errors).toEqual([stopError]);

      await flush();
      expect(capture.errors).toEqual([]);
    } finally {
      capture.dispose();
    }
  });

  it('runs shutdown sequencing without reporting on a clean stop', async () => {
    const stop = vi.fn(async () => undefined);
    const onStopped = vi.fn();
    const onError = vi.fn();
    const requestStop = createWorkerStopHandler({ stop, onStopped, onError });

    requestStop();
    await withTimeout(
      (async () => {
        while (onStopped.mock.calls.length === 0) {
          await flush(1);
        }
      })(),
      5000,
      'clean shutdown sequencing',
    );

    expect(stop).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
