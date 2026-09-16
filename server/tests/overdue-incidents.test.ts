import { describe, expect, it } from 'vitest';

import {
  APPROVAL_WAIT_BREACH_HOURS,
  approvalWaitBreachAt,
  approvalWaitDeadlineAt,
  effectiveSubmissionDeadlineAt,
  isInstantBreached,
  lateStartBreachAt,
  lateStartDeadlineAt,
  maxInstant,
  submissionBreachAt,
  submissionBreachInstant,
} from '../src/modules/job-cards/overdue-incidents.js';
import { isoInstant } from '../src/modules/job-cards/validation.js';

describe('OVR-2 incident deadline policy (unit)', () => {
  it('pins the approval-wait threshold to one named 24h constant', () => {
    expect(APPROVAL_WAIT_BREACH_HOURS).toBe(24);
  });

  it('derives LATE_START only from a real interval end', () => {
    expect(lateStartDeadlineAt(null)).toBeNull();
    expect(lateStartDeadlineAt('2026-08-03T07:30:00.000Z'))
      .toEqual(new Date('2026-08-03T07:30:00.000Z'));
  });

  it('reuses the shipped effective-deadline formula with the due fallback', () => {
    // Phase end wins over everything.
    expect(effectiveSubmissionDeadlineAt({
      scheduledEndsAt: '2026-08-03T07:30:00.000Z',
      scheduledAt: '2026-08-03T07:00:00.000Z',
      type: 'PRODUCT_DELIVERY',
      dueDate: '2026-08-01',
      timezone: 'Europe/Istanbul',
    })).toEqual(new Date('2026-08-03T07:30:00.000Z'));
    // Otherwise the start, except SALES_MEETING which stays ineligible.
    expect(effectiveSubmissionDeadlineAt({
      scheduledEndsAt: null,
      scheduledAt: '2026-08-03T07:00:00.000Z',
      type: 'GENERAL_TASK',
      dueDate: '2026-08-01',
      timezone: 'Europe/Istanbul',
    })).toEqual(new Date('2026-08-03T07:00:00.000Z'));
    expect(effectiveSubmissionDeadlineAt({
      scheduledEndsAt: null,
      scheduledAt: '2026-08-03T07:00:00.000Z',
      type: 'SALES_MEETING',
      dueDate: null,
      timezone: 'Europe/Istanbul',
    })).toBeNull();
    // Absent phase deadline falls back to the timezone-safe due boundary.
    expect(effectiveSubmissionDeadlineAt({
      scheduledEndsAt: null,
      scheduledAt: null,
      type: 'GENERAL_TASK',
      dueDate: '2026-08-01',
      timezone: 'Europe/Istanbul',
    })).toEqual(new Date('2026-08-01T21:00:00.000Z'));
    expect(effectiveSubmissionDeadlineAt({
      scheduledEndsAt: null,
      scheduledAt: null,
      type: 'GENERAL_TASK',
      dueDate: null,
      timezone: 'Europe/Istanbul',
    })).toBeNull();
  });

  it('defines deadline_at as the first-late boundary for each delay type', () => {
    const effective = new Date('2026-08-03T07:30:00.000Z');
    const breach = submissionBreachInstant(effective);
    expect(lateStartDeadlineAt(effective.toISOString())).toEqual(effective);
    expect(approvalWaitDeadlineAt(new Date('2026-08-04T09:00:00.000Z')))
      .toEqual(new Date('2026-08-05T09:00:00.000Z'));
    expect(breach.getTime()).toBeGreaterThan(effective.getTime());
    expect(isInstantBreached(breach, effective)).toBe(false);
    expect(isInstantBreached(breach, breach)).toBe(true);
  });

  it('breaches approval wait exactly at submitted + 24h', () => {
    const submitted = new Date('2026-08-04T09:00:00.000Z');
    const deadline = approvalWaitDeadlineAt(submitted);
    expect(deadline).toEqual(new Date('2026-08-05T09:00:00.000Z'));
    expect(isInstantBreached(deadline, new Date('2026-08-05T08:59:59.999Z'))).toBe(false);
    expect(isInstantBreached(deadline, deadline)).toBe(true);
  });

  it('proves the millisecond domain clock: schedule instants reject sub-ms input', () => {
    // isoInstant caps fractional seconds at three digits, so no
    // client-supplied scheduled instant can carry sub-millisecond precision
    // into the breach comparison. +1ms is therefore the next representable
    // domain instant after an effective deadline.
    expect(isoInstant('2026-08-03T07:30:00.000Z', 'at')).toBe('2026-08-03T07:30:00.000Z');
    expect(isoInstant('2026-08-03T07:30:00.123Z', 'at')).toBe('2026-08-03T07:30:00.123Z');
    expect(() => isoInstant('2026-08-03T07:30:00.0001Z', 'at')).toThrow();
    expect(() => isoInstant('2026-08-03T07:30:00.000001Z', 'at')).toThrow();
    expect(submissionBreachInstant(new Date('2026-08-03T07:30:00.000Z')))
      .toEqual(new Date('2026-08-03T07:30:00.001Z'));
  });

  it('computes breached_at as max(nominal, eligibility, revision activation)', () => {
    const nominal = new Date('2026-08-03T07:30:00.000Z');
    const past = new Date('2026-08-03T06:00:00.000Z');
    // Normal case collapses to the first-late boundary.
    expect(lateStartBreachAt({
      deadlineAt: nominal, acceptedAt: past, revisionEffectiveAt: past,
    })).toEqual(nominal);
    // Late acceptance moves the breach to acceptance, never before it.
    const accepted = new Date('2026-08-03T08:00:00.000Z');
    expect(lateStartBreachAt({
      deadlineAt: nominal, acceptedAt: accepted, revisionEffectiveAt: past,
    })).toEqual(accepted);
    // Retroactive revision moves the breach to revision activation.
    const activated = new Date('2026-08-03T10:00:00.000Z');
    expect(lateStartBreachAt({
      deadlineAt: nominal, acceptedAt: past, revisionEffectiveAt: activated,
    })).toEqual(activated);
    expect(maxInstant(nominal, past, activated)).toEqual(activated);
    expect(maxInstant(nominal)).toEqual(nominal);
    // Submission episodes use the effective deadline +1ms first-late instant.
    expect(submissionBreachAt({
      nominalFirstLateAt: new Date('2026-08-03T07:30:00.001Z'),
      episodeActivationAt: past,
      revisionEffectiveAt: past,
    })).toEqual(new Date('2026-08-03T07:30:00.001Z'));
    expect(submissionBreachAt({
      nominalFirstLateAt: new Date('2026-08-03T07:30:00.001Z'),
      episodeActivationAt: accepted,
      revisionEffectiveAt: past,
    })).toEqual(accepted);
    // Approval wait collapses to submitted + 24h (eligibility starts at submit).
    const submitted = new Date('2026-08-04T09:00:00.000Z');
    expect(approvalWaitBreachAt({
      deadlineAt: new Date('2026-08-05T09:00:00.000Z'),
      submittedAt: submitted,
      revisionEffectiveAt: past,
    })).toEqual(new Date('2026-08-05T09:00:00.000Z'));
  });
});
