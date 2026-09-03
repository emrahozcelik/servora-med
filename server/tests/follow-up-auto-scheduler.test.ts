import { describe, expect, it } from 'vitest';

import { findEarliestFollowUpSlot } from '../src/modules/job-cards/follow-up-auto-scheduler.js';

describe('findEarliestFollowUpSlot', () => {
  it('selects the earliest organization-local quarter-hour at or after the lead boundary', () => {
    const slot = findEarliestFollowUpSlot({
      earliestAllowedAt: new Date('2026-08-01T10:07:00.000Z'),
      type: 'SALES_MEETING',
      timezone: 'UTC',
      blockers: [],
    });

    expect(slot?.startsAt.toISOString()).toBe('2026-08-01T10:15:00.000Z');
    expect(slot?.endsAt.toISOString()).toBe('2026-08-01T11:15:00.000Z');
  });

  it('skips overlaps while allowing an exactly back-to-back slot', () => {
    const slot = findEarliestFollowUpSlot({
      earliestAllowedAt: new Date('2026-08-01T10:00:00.000Z'),
      type: 'SALES_MEETING',
      timezone: 'UTC',
      blockers: [{
        startsAt: new Date('2026-08-01T10:30:00.000Z'),
        endsAt: new Date('2026-08-01T11:30:00.000Z'),
      }],
    });

    expect(slot?.startsAt.toISOString()).toBe('2026-08-01T11:30:00.000Z');
  });

  it('reuses the canonical Product Delivery duration and invents no General Task duration', () => {
    const productSlot = findEarliestFollowUpSlot({
      earliestAllowedAt: new Date('2026-08-01T10:00:00.000Z'),
      type: 'PRODUCT_DELIVERY',
      timezone: 'UTC',
      blockers: [],
    });
    const generalSlot = findEarliestFollowUpSlot({
      earliestAllowedAt: new Date('2026-08-01T10:00:00.000Z'),
      type: 'GENERAL_TASK',
      timezone: 'UTC',
      blockers: [],
    });

    expect(productSlot?.endsAt.toISOString()).toBe('2026-08-01T10:30:00.000Z');
    expect(generalSlot).toBeNull();
  });

  it('skips nonexistent spring-forward wall clocks', () => {
    const slot = findEarliestFollowUpSlot({
      earliestAllowedAt: new Date('2026-03-08T06:58:00.000Z'),
      type: 'SALES_MEETING',
      timezone: 'America/New_York',
      blockers: [],
    });

    expect(slot?.startsAt.toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  it('resolves repeated fall-back wall clocks deterministically with increasing UTC candidates', () => {
    const input = {
      earliestAllowedAt: new Date('2026-11-01T04:58:00.000Z'),
      type: 'SALES_MEETING' as const,
      timezone: 'America/New_York',
      blockers: [],
    };
    const first = findEarliestFollowUpSlot(input);
    const second = findEarliestFollowUpSlot(input);

    expect(second).toEqual(first);
    expect(first!.startsAt.valueOf()).toBeGreaterThanOrEqual(input.earliestAllowedAt.valueOf());
    expect(first!.endsAt.valueOf()).toBeGreaterThan(first!.startsAt.valueOf());
  });

  it('returns no slot when the bounded 30-day horizon is fully blocked', () => {
    const slot = findEarliestFollowUpSlot({
      earliestAllowedAt: new Date('2026-08-01T10:00:00.000Z'),
      type: 'SALES_MEETING',
      timezone: 'UTC',
      blockers: [{
        startsAt: new Date('2026-08-01T00:00:00.000Z'),
        endsAt: new Date('2026-09-01T00:00:00.000Z'),
      }],
    });

    expect(slot).toBeNull();
  });
});
