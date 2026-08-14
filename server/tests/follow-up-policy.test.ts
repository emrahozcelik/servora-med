import { describe, expect, it } from 'vitest';

import {
  FOLLOW_UP_DEFAULT_INTERVAL_DAYS,
  FOLLOW_UP_SEARCH_HORIZON_DAYS,
  FREQUENT_VISIT_MAX_COUNT,
  FREQUENT_VISIT_WINDOW_DAYS,
  RECENT_VISIT_WARNING_DAYS,
  advanceByOneDay,
  defaultFollowUpInstructions,
  defaultFollowUpType,
  deriveProposalOrigin,
  suggestedFollowUpInstant,
} from '../src/modules/job-cards/follow-up-policy.js';

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

  it('keeps the recent-visit and frequency windows with max 3', () => {
    expect(RECENT_VISIT_WARNING_DAYS).toBe(7);
    expect(FREQUENT_VISIT_WINDOW_DAYS).toBe(14);
    expect(FREQUENT_VISIT_MAX_COUNT).toBe(3);
  });

  it('maps follow-up type defaults', () => {
    expect(defaultFollowUpType('SALES_MEETING')).toBe('SALES_MEETING');
    expect(defaultFollowUpType('PRODUCT_DELIVERY')).toBe('SALES_MEETING');
    expect(defaultFollowUpType('GENERAL_TASK')).toBe('GENERAL_TASK');
  });
});

describe('suggestedFollowUpInstant', () => {
  it('adds exactly 7 calendar days to the evaluation date', () => {
    const result = suggestedFollowUpInstant({
      evaluatedAt: instant('2026-08-01T09:00:00.000Z'),
      sourceScheduledAt: null,
    });
    expect(result.toISOString()).toBe('2026-08-08T09:00:00.000Z');
  });

  it('preserves the source scheduledAt clock time when available', () => {
    const result = suggestedFollowUpInstant({
      evaluatedAt: instant('2026-08-01T18:45:00.000Z'),
      sourceScheduledAt: instant('2026-07-30T10:30:00.000Z'),
    });
    expect(result.toISOString()).toBe('2026-08-08T10:30:00.000Z');
  });

  it('does not skip weekends (no business-day rule exists)', () => {
    const result = suggestedFollowUpInstant({
      evaluatedAt: instant('2026-08-08T10:00:00.000Z'),
      sourceScheduledAt: null,
    });
    expect(result.toISOString()).toBe('2026-08-15T10:00:00.000Z');
  });
});

describe('advanceByOneDay', () => {
  it('advances one calendar day and preserves the clock time', () => {
    expect(advanceByOneDay(instant('2026-08-15T10:30:00.000Z')).toISOString())
      .toBe('2026-08-16T10:30:00.000Z');
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
