import { describe, expect, it } from 'vitest';

import {
  FOLLOW_UP_DEFAULT_INTERVAL_DAYS,
  FOLLOW_UP_MIN_LEAD_MINUTES,
  FOLLOW_UP_SEARCH_HORIZON_DAYS,
  FREQUENT_VISIT_ADVISORY_THRESHOLD,
  FREQUENT_VISIT_WINDOW_DAYS,
  RECENT_VISIT_WARNING_DAYS,
  advanceByOneDay,
  defaultFollowUpInstructions,
  defaultFollowUpType,
  deriveProposalOrigin,
  followUpIntervalDays,
  followUpTargetInstant,
  requiresMandatoryFollowUpProposal,
  suggestedFollowUpInstant,
  isFollowUpMinimumLeadSatisfied,
  followUpLeadReferenceAt,
  assertFollowUpCancelContinuity,
  isFollowUpVisit,
  parseFollowUpCancelContinuity,
} from '../src/modules/job-cards/follow-up-policy.js';
import type {
  JobCardEngagementKind,
  JobCardType,
} from '../src/modules/job-cards/types.js';
import {
  localClockParts,
  localDateKey,
} from '../src/modules/job-cards/local-calendar.js';

const instant = (value: string) => new Date(value);
const proposal = (overrides: Partial<{
  scheduledAt: Date; type: 'SALES_MEETING' | 'PRODUCT_DELIVERY' | 'GENERAL_TASK';
  assignedTo: string; followUpInstructions: string;
}> = {}) => ({
  scheduledAt: instant('2026-08-08T10:30:00.000Z'),
  type: 'SALES_MEETING' as const,
  assignedTo: 'staff-1',
  followUpInstructions: 'Takip: Görüşme',
  ...overrides,
});

describe('follow-up policy V1 constants', () => {
  it('uses +7 days for every Job type', () => {
    expect(FOLLOW_UP_DEFAULT_INTERVAL_DAYS).toBe(7);
  });

  it('keeps the 30-day search horizon', () => {
    expect(FOLLOW_UP_SEARCH_HORIZON_DAYS).toBe(30);
  });

  it('enforces a 15-minute minimum lead at the exact boundary', () => {
    expect(FOLLOW_UP_MIN_LEAD_MINUTES).toBe(15);
    const referenceAt = instant('2026-08-08T10:00:00.000Z');
    expect(isFollowUpMinimumLeadSatisfied({
      referenceAt,
      scheduledAt: instant('2026-08-08T10:14:59.000Z'),
    })).toBe(false);
    expect(isFollowUpMinimumLeadSatisfied({
      referenceAt,
      scheduledAt: instant('2026-08-08T10:15:00.000Z'),
    })).toBe(true);
    expect(isFollowUpMinimumLeadSatisfied({
      referenceAt,
      scheduledAt: instant('2026-08-08T10:15:01.000Z'),
    })).toBe(true);
  });

  it('compares timezone-offset values as instants without local-clock arithmetic', () => {
    const referenceAt = instant('2026-03-29T01:45:00+03:00');
    expect(isFollowUpMinimumLeadSatisfied({
      referenceAt,
      scheduledAt: instant('2026-03-28T23:00:00.000Z'),
    })).toBe(true);
    expect(isFollowUpMinimumLeadSatisfied({
      referenceAt,
      scheduledAt: instant('2026-03-28T22:59:59.000Z'),
    })).toBe(false);
  });

  it('uses the later of the visit timestamp and request timestamp as lead reference', () => {
    const requestAt = instant('2026-08-08T10:00:00.000Z');
    expect(followUpLeadReferenceAt({
      meetingAt: instant('2026-08-08T09:45:00.000Z'),
      requestAt,
    })).toEqual(requestAt);
    expect(followUpLeadReferenceAt({
      meetingAt: instant('2026-08-08T10:05:00.000Z'),
      requestAt,
    })).toEqual(instant('2026-08-08T10:05:00.000Z'));
    expect(followUpLeadReferenceAt({ meetingAt: null, requestAt })).toEqual(requestAt);
  });

  it('keeps the recent-visit and frequency windows with advisory threshold 3', () => {
    expect(RECENT_VISIT_WARNING_DAYS).toBe(7);
    expect(FREQUENT_VISIT_WINDOW_DAYS).toBe(14);
    // Advisory trigger only; never a write limit.
    expect(FREQUENT_VISIT_ADVISORY_THRESHOLD).toBe(3);
  });

  it('maps follow-up type defaults', () => {
    expect(defaultFollowUpType('SALES_MEETING')).toBe('SALES_MEETING');
    expect(defaultFollowUpType('PRODUCT_DELIVERY')).toBe('SALES_MEETING');
    expect(defaultFollowUpType('GENERAL_TASK')).toBe('GENERAL_TASK');
  });

  it('requires a proposal for POSITIVE or unsuccessful visit-cycle sales meetings (JOB-008)', () => {
    for (const engagementKind of ['CUSTOMER_VISIT', 'FOLLOW_UP'] as const) {
      expect(requiresMandatoryFollowUpProposal({
        type: 'SALES_MEETING',
        engagementKind,
        outcome: 'FOLLOW_UP_REQUIRED',
        unsuccessfulReason: 'CONTACT_NOT_AVAILABLE',
      })).toBe(true);
      expect(requiresMandatoryFollowUpProposal({
        type: 'SALES_MEETING',
        engagementKind,
        outcome: 'POSITIVE',
        unsuccessfulReason: null,
      })).toBe(true);
      expect(requiresMandatoryFollowUpProposal({
        type: 'SALES_MEETING',
        engagementKind,
        outcome: 'FOLLOW_UP_REQUIRED',
        unsuccessfulReason: null,
      })).toBe(false);
      for (const outcome of ['NO_DECISION', 'NOT_INTERESTED'] as const) {
        expect(requiresMandatoryFollowUpProposal({
          type: 'SALES_MEETING', engagementKind, outcome, unsuccessfulReason: null,
        })).toBe(false);
      }
      expect(requiresMandatoryFollowUpProposal({ type: 'SALES_MEETING', engagementKind })).toBe(false);
    }

    const nonLoopCases = [
      { type: 'SALES_MEETING', engagementKind: 'SALES_MEETING' },
      { type: 'SALES_MEETING', engagementKind: 'PRODUCT_DEMO' },
      { type: 'SALES_MEETING', engagementKind: 'TRAINING' },
      { type: 'SALES_MEETING', engagementKind: 'OTHER' },
      { type: 'SALES_MEETING', engagementKind: null },
      { type: 'GENERAL_TASK', engagementKind: null },
      { type: 'PRODUCT_DELIVERY', engagementKind: null },
    ] satisfies Array<{
      type: JobCardType;
      engagementKind: JobCardEngagementKind | null;
    }>;
    for (const input of nonLoopCases) {
      expect(requiresMandatoryFollowUpProposal({ ...input, outcome: 'POSITIVE' })).toBe(false);
      expect(requiresMandatoryFollowUpProposal({
        ...input, outcome: 'FOLLOW_UP_REQUIRED', unsuccessfulReason: 'REQUESTED_LATER',
      })).toBe(false);
    }
  });

  it('maps outcomes to the JOB-008 calendar-day intervals', () => {
    expect(followUpIntervalDays('FOLLOW_UP_REQUIRED')).toBe(7);
    expect(followUpIntervalDays('POSITIVE')).toBe(14);
    expect(followUpIntervalDays(null)).toBe(7);
  });

  it('prefers a valid nextFollowUpAt over the outcome interval', () => {
    const base = {
      evaluatedAt: instant('2026-08-03T09:00:00.000Z'),
      sourceScheduledAt: instant('2026-08-03T09:00:00.000Z'),
      timezone: 'UTC',
      durationMs: 60 * 60_000,
    };
    expect(followUpTargetInstant({ ...base, outcome: 'POSITIVE' }).toISOString())
      .toBe('2026-08-17T09:00:00.000Z');
    expect(followUpTargetInstant({ ...base, outcome: 'FOLLOW_UP_REQUIRED' }).toISOString())
      .toBe('2026-08-10T09:00:00.000Z');
    expect(followUpTargetInstant({
      ...base, outcome: 'POSITIVE', nextFollowUpAt: '2026-08-05T13:00:00.000Z',
    }).toISOString()).toBe('2026-08-05T13:00:00.000Z');
  });
});

describe('suggestedFollowUpInstant', () => {
  it('adds exactly 7 calendar days to the evaluation date', () => {
    const result = suggestedFollowUpInstant({
      evaluatedAt: instant('2026-08-01T09:00:00.000Z'),
      sourceScheduledAt: null,
      timezone: 'UTC',
    });
    expect(result.toISOString()).toBe('2026-08-08T09:00:00.000Z');
  });

  it('preserves the source scheduledAt clock time when available', () => {
    const result = suggestedFollowUpInstant({
      evaluatedAt: instant('2026-08-01T18:45:00.000Z'),
      sourceScheduledAt: instant('2026-07-30T10:30:00.000Z'),
      timezone: 'UTC',
    });
    expect(result.toISOString()).toBe('2026-08-08T10:30:00.000Z');
  });

  it('keeps a +7 target that lands on a Saturday (no business-day rule exists)', () => {
    const result = suggestedFollowUpInstant({
      evaluatedAt: instant('2026-08-08T10:00:00.000Z'),
      sourceScheduledAt: null,
      timezone: 'UTC',
    });
    expect(result.toISOString()).toBe('2026-08-15T10:00:00.000Z');
  });

  it('§17: advances a +7 target that lands on a Sunday to the next working day', () => {
    // 2026-08-09 is a Sunday; +7 calendar days is Sunday 2026-08-16, which must
    // advance to Monday 2026-08-17 while preserving the organization-local clock.
    const result = suggestedFollowUpInstant({
      evaluatedAt: instant('2026-08-09T10:00:00.000Z'),
      sourceScheduledAt: null,
      timezone: 'UTC',
    });
    expect(result.toISOString()).toBe('2026-08-17T10:00:00.000Z');
    expect(localClockParts(result, 'UTC')).toEqual({ hour: 10, minute: 0 });
  });

  it('§17: skips a Saturday target whose canonical duration spills into Sunday', () => {
    // 2026-08-08 is a Saturday; +7 is Saturday 2026-08-15. A 1-hour meeting at
    // 23:30 ends Sunday 00:30, so the target advances past Sunday to Monday.
    const result = suggestedFollowUpInstant({
      evaluatedAt: instant('2026-08-08T23:30:00.000Z'),
      sourceScheduledAt: null,
      timezone: 'UTC',
      durationMs: 60 * 60_000,
    });
    expect(result.toISOString()).toBe('2026-08-17T23:30:00.000Z');
  });

  it('R1-3: computes +7 on the organization-local calendar date near midnight', () => {
    // 2026-08-14T22:30Z is already 15 Aug 01:30 in Europe/Istanbul.
    const result = suggestedFollowUpInstant({
      evaluatedAt: instant('2026-08-14T22:30:00.000Z'),
      sourceScheduledAt: instant('2026-08-14T07:00:00.000Z'), // 10:00 Istanbul
      timezone: 'Europe/Istanbul',
    });
    expect(localDateKey(result, 'Europe/Istanbul')).toBe('2026-08-22');
    expect(localClockParts(result, 'Europe/Istanbul')).toEqual({ hour: 10, minute: 0 });
    expect(result.toISOString()).toBe('2026-08-22T07:00:00.000Z');
  });
});

describe('advanceByOneDay', () => {
  it('advances one calendar day and preserves the clock time', () => {
    expect(advanceByOneDay(instant('2026-08-15T10:30:00.000Z'), 'UTC').toISOString())
      .toBe('2026-08-16T10:30:00.000Z');
  });

  it('R1-4: advances one organization-local calendar day', () => {
    const result = advanceByOneDay(instant('2026-08-08T23:30:00.000Z'), 'Europe/Istanbul');
    expect(localDateKey(result, 'Europe/Istanbul')).toBe('2026-08-10');
    expect(localClockParts(result, 'Europe/Istanbul')).toEqual({ hour: 2, minute: 30 });
  });

  it('R1-4 DST: preserves local clock across a spring-forward boundary', () => {
    // 2026-03-07T15:00Z is 10:00 EST in America/New_York; 2026-03-08 is EDT.
    const result = advanceByOneDay(instant('2026-03-07T15:00:00.000Z'), 'America/New_York');
    expect(localDateKey(result, 'America/New_York')).toBe('2026-03-08');
    expect(localClockParts(result, 'America/New_York')).toEqual({ hour: 10, minute: 0 });
    expect(result.toISOString()).toBe('2026-03-08T14:00:00.000Z');
  });
});

describe('defaultFollowUpInstructions', () => {
  it('prepends a Takip scope to the source title', () => {
    expect(defaultFollowUpInstructions('  Ürün tanıtımı  ')).toBe('Takip: Ürün tanıtımı');
  });
});

describe('deriveProposalOrigin', () => {
  it('marks an unchanged proposal as SYSTEM', () => {
    const suggestion = proposal();
    expect(deriveProposalOrigin(proposal(), suggestion)).toBe('SYSTEM');
  });

  it('marks a changed date/time as STAFF_ADJUSTED', () => {
    const suggestion = proposal();
    expect(deriveProposalOrigin(
      proposal({ scheduledAt: instant('2026-08-09T10:30:00.000Z') }),
      suggestion,
    )).toBe('STAFF_ADJUSTED');
  });

  it('marks changed instructions as STAFF_ADJUSTED', () => {
    const suggestion = proposal();
    expect(deriveProposalOrigin(
      proposal({ followUpInstructions: 'Farklı kapsam' }),
      suggestion,
    )).toBe('STAFF_ADJUSTED');
  });

  it('marks a changed assignee or type as STAFF_ADJUSTED', () => {
    const suggestion = proposal();
    expect(deriveProposalOrigin(
      proposal({ assignedTo: 'staff-2' }),
      suggestion,
    )).toBe('STAFF_ADJUSTED');
    expect(deriveProposalOrigin(
      proposal({ type: 'GENERAL_TASK' }),
      suggestion,
    )).toBe('STAFF_ADJUSTED');
  });
});

describe('JOB-009 follow-up cancel continuity', () => {
  const followUp = { type: 'SALES_MEETING' as const, engagementKind: 'FOLLOW_UP' as const };
  const visit = { type: 'SALES_MEETING' as const, engagementKind: 'CUSTOMER_VISIT' as const };
  const now = new Date('2026-11-18T09:00:00.000Z');

  it('identifies only SALES_MEETING / FOLLOW_UP JobCards as follow-up visits', () => {
    expect(isFollowUpVisit(followUp)).toBe(true);
    expect(isFollowUpVisit(visit)).toBe(false);
    expect(isFollowUpVisit({ type: 'GENERAL_TASK', engagementKind: null })).toBe(false);
  });

  it('parses exactly one known decision shape', () => {
    expect(parseFollowUpCancelContinuity(undefined)).toBeNull();
    expect(parseFollowUpCancelContinuity(null)).toBeNull();
    expect(parseFollowUpCancelContinuity({ decision: 'END_CYCLE', endReason: 'CUSTOMER_INACTIVE' }))
      .toEqual({ decision: 'END_CYCLE', endReason: 'CUSTOMER_INACTIVE' });
    expect(parseFollowUpCancelContinuity({ decision: 'RESCHEDULE', scheduledAt: '2026-11-20T10:00:00+03:00' }))
      .toEqual({ decision: 'RESCHEDULE', scheduledAt: '2026-11-20T07:00:00.000Z' });
    for (const invalid of [
      'END_CYCLE',
      [],
      {},
      { decision: 'END_CYCLE' },
      { decision: 'END_CYCLE', endReason: 'BUDGET' },
      { decision: 'END_CYCLE', endReason: 'OTHER', scheduledAt: '2026-11-20T10:00:00Z' },
      { decision: 'RESCHEDULE' },
      { decision: 'RESCHEDULE', scheduledAt: '2026-11-20 10:00' },
      { decision: 'RESCHEDULE', scheduledAt: '2026-11-20T10:00:00Z', endReason: 'OTHER' },
    ]) {
      expect(() => parseFollowUpCancelContinuity(invalid)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }),
      );
    }
  });

  it('requires a decision for follow-up visits and forbids it elsewhere', () => {
    expect(() => assertFollowUpCancelContinuity(followUp, null, now))
      .toThrow(expect.objectContaining({ code: 'FOLLOW_UP_CANCEL_DECISION_REQUIRED' }));
    expect(() => assertFollowUpCancelContinuity(visit, { decision: 'END_CYCLE', endReason: 'OTHER' }, now))
      .toThrow(expect.objectContaining({ code: 'FOLLOW_UP_CANCEL_DECISION_INVALID' }));
    expect(() => assertFollowUpCancelContinuity(visit, null, now)).not.toThrow();
    expect(() => assertFollowUpCancelContinuity(followUp, { decision: 'END_CYCLE', endReason: 'OTHER' }, now))
      .not.toThrow();
  });

  it('requires a replacement strictly after the request time', () => {
    expect(() => assertFollowUpCancelContinuity(
      followUp, { decision: 'RESCHEDULE', scheduledAt: now.toISOString() }, now,
    )).toThrow(expect.objectContaining({ code: 'FOLLOW_UP_RESCHEDULE_IN_PAST' }));
    expect(() => assertFollowUpCancelContinuity(
      followUp, { decision: 'RESCHEDULE', scheduledAt: '2026-11-18T09:15:00.000Z' }, now,
    )).not.toThrow();
  });
});
