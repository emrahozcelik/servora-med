import { describe, expect, it, vi } from 'vitest';

import {
  createCalendarReminderWorker,
  type CalendarReminderClaim,
  type CalendarReminderWorkerRepository,
} from '../src/modules/calendar/reminder-worker.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const claim: CalendarReminderClaim = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  recipientUserId: '22222222-2222-4222-8222-222222222222',
  jobCardId: null,
  calendarEventId: '33333333-3333-4333-8333-333333333333',
  attemptCount: 1,
  leaseToken: '44444444-4444-4444-8444-444444444444',
};
const realtime: RealtimeEventRecord = {
  id: 1n,
  organizationId: claim.organizationId,
  sourceActivityId: null,
  type: 'calendar.reminder_due',
  entityType: 'calendar-event',
  entityId: claim.calendarEventId!,
  actorUserId: null,
  audience: { roles: [], userIds: [claim.recipientUserId] },
  resourceKeys: ['calendar', 'notifications'],
  occurredAt: new Date('2026-07-26T08:30:00.000Z'),
};

function repository(overrides: Partial<CalendarReminderWorkerRepository> = {}) {
  return {
    claimDue: vi.fn(async () => [claim]),
    project: vi.fn(async () => realtime),
    retry: vi.fn(async () => undefined),
    abandon: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    ...overrides,
  } satisfies CalendarReminderWorkerRepository;
}

describe('calendar reminder worker', () => {
  it('claims exact-boundary work and projects without provider I/O', async () => {
    const repo = repository();
    const publish = vi.fn();
    const worker = createCalendarReminderWorker(repo, {
      now: () => new Date('2026-07-26T08:30:00.000Z'),
      publisher: { publish },
      webPushEnabled: true,
    });
    await expect(worker.runOnce()).resolves.toBe(1);
    expect(repo.claimDue).toHaveBeenCalledWith(
      new Date('2026-07-26T08:30:00.000Z'),
      expect.any(String),
      new Date('2026-07-26T08:31:00.000Z'),
      20,
    );
    expect(repo.project).toHaveBeenCalledWith(
      claim,
      new Date('2026-07-26T08:30:00.000Z'),
      true,
    );
    expect(publish).toHaveBeenCalledWith(realtime);
  });

  it('uses the bounded retry schedule and abandons exhausted claims', async () => {
    const transient = repository({
      project: vi.fn(async () => { throw new Error('db'); }),
    });
    await createCalendarReminderWorker(transient, {
      now: () => new Date('2026-07-26T08:30:00.000Z'),
    }).runOnce();
    expect(transient.retry).toHaveBeenCalledWith(
      claim,
      new Date('2026-07-26T08:30:00.000Z'),
      new Date('2026-07-26T08:30:30.000Z'),
      'PROJECTION_FAILED',
    );

    const exhausted = repository({
      claimDue: vi.fn(async () => [{ ...claim, attemptCount: 6 }]),
      project: vi.fn(async () => { throw new Error('db'); }),
    });
    await createCalendarReminderWorker(exhausted).runOnce();
    expect(exhausted.abandon).toHaveBeenCalled();
  });

  it('releases this worker lease during graceful stop', async () => {
    const repo = repository({ claimDue: vi.fn(async () => []) });
    const worker = createCalendarReminderWorker(repo);
    await worker.stop();
    expect(repo.release).toHaveBeenCalledWith(expect.any(String), expect.any(Date));
  });

  it.each([
    [false, 0],
    [true, 1],
  ] as const)('starts and stops only when calendar capability is %s', async (enabled, calls) => {
    const start = vi.fn();
    const stop = vi.fn(async () => undefined);
    const app = await buildApp(loadConfig({
      DATABASE_URL: 'postgresql://user:password@127.0.0.1:5432/test',
      CALENDAR_ENABLED: String(enabled),
    }), {
      authRepository: {
        authenticate: vi.fn(),
        provision: vi.fn(),
        handlePasswordChange: vi.fn(),
      },
      calendarRepository: {} as never,
      calendarReminderWorker: { start, stop, runOnce: vi.fn(async () => 0) },
    });
    await app.ready();
    expect(start).toHaveBeenCalledTimes(calls);
    await app.close();
    expect(stop).toHaveBeenCalledTimes(calls);
  });
});
