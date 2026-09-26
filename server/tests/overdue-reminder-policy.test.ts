import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MANAGEMENT_ESCALATION_MINUTES,
  DEFAULT_OVERDUE_REMINDER_POLICY,
  DEFAULT_STAFF_REMINDER_MINUTES,
  OVERDUE_REMINDER_DELAY_TYPE,
  OVERDUE_REMINDER_KINDS,
  OVERDUE_REMINDER_NOTIFICATION_KIND,
  OVERDUE_REMINDER_REALTIME_TYPE,
  createOverdueReminderPolicy,
} from '../src/modules/job-cards/overdue-reminder-policy.js';

const BREACH = new Date('2026-08-03T07:30:00.000Z');

describe('OVR-4 reminder policy', () => {
  it('declares exactly the two reminder kinds and one delay type', () => {
    expect(OVERDUE_REMINDER_KINDS).toEqual([
      'STAFF_SUBMISSION_REMINDER',
      'MANAGEMENT_ESCALATION',
    ]);
    // No new overdue delay type is introduced: the policy only projects the
    // existing LATE_SUBMISSION breach.
    expect(OVERDUE_REMINDER_DELAY_TYPE).toBe('LATE_SUBMISSION');
  });

  it('defaults to a 15-minute staff nudge and a 60-minute escalation', () => {
    expect(DEFAULT_STAFF_REMINDER_MINUTES).toBe(15);
    expect(DEFAULT_MANAGEMENT_ESCALATION_MINUTES).toBe(60);
    expect(DEFAULT_OVERDUE_REMINDER_POLICY.thresholds).toEqual({
      staffReminderMinutes: 15,
      managementEscalationMinutes: 60,
    });
  });

  it('derives each due instant from the immutable breached_at, not from now', () => {
    const policy = createOverdueReminderPolicy();
    expect(policy.dueAt(BREACH, 'STAFF_SUBMISSION_REMINDER').toISOString())
      .toBe('2026-08-03T07:45:00.000Z');
    expect(policy.dueAt(BREACH, 'MANAGEMENT_ESCALATION').toISOString())
      .toBe('2026-08-03T08:30:00.000Z');
  });

  it('is inclusive at the exact threshold instant (>=, not >)', () => {
    const policy = createOverdueReminderPolicy();
    const justBefore = new Date('2026-08-03T07:44:59.999Z');
    const exactly = new Date('2026-08-03T07:45:00.000Z');
    expect(policy.isDue('STAFF_SUBMISSION_REMINDER', BREACH, justBefore)).toBe(false);
    expect(policy.isDue('STAFF_SUBMISSION_REMINDER', BREACH, exactly)).toBe(true);
  });

  it('reports every due kind in escalation order at a request time', () => {
    const policy = createOverdueReminderPolicy();
    expect(policy.dueKinds(BREACH, new Date('2026-08-03T07:40:00.000Z'))).toEqual([]);
    expect(policy.dueKinds(BREACH, new Date('2026-08-03T07:45:00.000Z')))
      .toEqual(['STAFF_SUBMISSION_REMINDER']);
    expect(policy.dueKinds(BREACH, new Date('2026-08-03T08:30:00.000Z')))
      .toEqual(['STAFF_SUBMISSION_REMINDER', 'MANAGEMENT_ESCALATION']);
  });

  it('accepts an explicit valid configuration', () => {
    const policy = createOverdueReminderPolicy({
      staffReminderMinutes: 5,
      managementEscalationMinutes: 20,
    });
    expect(policy.thresholdMinutes('STAFF_SUBMISSION_REMINDER')).toBe(5);
    expect(policy.thresholdMinutes('MANAGEMENT_ESCALATION')).toBe(20);
    expect(policy.dueAt(BREACH, 'MANAGEMENT_ESCALATION').toISOString())
      .toBe('2026-08-03T07:50:00.000Z');
  });

  it('allows an escalation equal to the staff threshold but never before it', () => {
    const equal = createOverdueReminderPolicy({
      staffReminderMinutes: 30,
      managementEscalationMinutes: 30,
    });
    expect(equal.thresholds.managementEscalationMinutes).toBe(30);
    expect(() => createOverdueReminderPolicy({
      staffReminderMinutes: 30,
      managementEscalationMinutes: 10,
    })).toThrow(/greater than or equal to/);
  });

  it.each([
    ['staffReminderMinutes', { staffReminderMinutes: 0 }],
    ['staffReminderMinutes', { staffReminderMinutes: -5 }],
    ['staffReminderMinutes', { staffReminderMinutes: 1.5 }],
    ['managementEscalationMinutes', { managementEscalationMinutes: 0 }],
    ['managementEscalationMinutes', { managementEscalationMinutes: Number.NaN }],
  ])('rejects a nonsensical %s = %o', (_field, input) => {
    expect(() => createOverdueReminderPolicy(input)).toThrow(/positive integer/);
  });

  it('keeps the notification and realtime projections exhaustive per kind', () => {
    expect(OVERDUE_REMINDER_NOTIFICATION_KIND).toEqual({
      STAFF_SUBMISSION_REMINDER: 'job.submission_reminder',
      MANAGEMENT_ESCALATION: 'job.submission_escalation',
    });
    expect(OVERDUE_REMINDER_REALTIME_TYPE).toEqual({
      STAFF_SUBMISSION_REMINDER: 'job.submission_reminder_due',
      MANAGEMENT_ESCALATION: 'job.submission_escalation_due',
    });
  });
});
