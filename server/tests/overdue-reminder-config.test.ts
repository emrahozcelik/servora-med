import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const validEnvironment = {
  DATABASE_URL: 'postgresql://servora:servora@localhost:5432/servora_med',
};

describe('OVR-4 overdue reminder configuration', () => {
  it('stays unconfigured (worker not constructed) without any OVERDUE_REMINDER_ key', () => {
    expect(loadConfig(validEnvironment).overdueReminders).toBeUndefined();
  });

  it('applies the 15/60 product defaults and worker cadence when enabled alone', () => {
    expect(loadConfig({ ...validEnvironment, OVERDUE_REMINDER_ENABLED: 'true' }).overdueReminders)
      .toEqual({
        enabled: true,
        pollIntervalMs: 60_000,
        batchSize: 20,
        staffReminderMinutes: 15,
        managementEscalationMinutes: 60,
      });
  });

  it('honours explicit thresholds and worker tuning', () => {
    expect(loadConfig({
      ...validEnvironment,
      OVERDUE_REMINDER_ENABLED: 'true',
      OVERDUE_REMINDER_STAFF_MINUTES: '5',
      OVERDUE_REMINDER_MANAGEMENT_MINUTES: '45',
      OVERDUE_REMINDER_POLL_INTERVAL_MS: '5000',
      OVERDUE_REMINDER_BATCH_SIZE: '100',
    }).overdueReminders).toMatchObject({
      staffReminderMinutes: 5,
      managementEscalationMinutes: 45,
      pollIntervalMs: 5_000,
      batchSize: 100,
    });
  });

  it('keeps an explicitly disabled worker configured but off', () => {
    expect(loadConfig({ ...validEnvironment, OVERDUE_REMINDER_ENABLED: 'false' }).overdueReminders)
      .toMatchObject({ enabled: false });
  });

  it.each([
    ['escalation before the staff nudge', { OVERDUE_REMINDER_MANAGEMENT_MINUTES: '10' }],
    ['a zero staff threshold', { OVERDUE_REMINDER_STAFF_MINUTES: '0' }],
    ['a threshold beyond one week', { OVERDUE_REMINDER_STAFF_MINUTES: '10081' }],
    ['a non-numeric threshold', { OVERDUE_REMINDER_STAFF_MINUTES: 'soon' }],
    ['an out-of-range batch size', { OVERDUE_REMINDER_BATCH_SIZE: '501' }],
    ['an out-of-range poll interval', { OVERDUE_REMINDER_POLL_INTERVAL_MS: '10' }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => loadConfig({
      ...validEnvironment,
      OVERDUE_REMINDER_ENABLED: 'true',
      ...overrides,
    })).toThrow();
  });
});
