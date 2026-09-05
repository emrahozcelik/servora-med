import { describe, expect, it } from 'vitest';

import {
  findEarliestFollowUpSlot,
  generateFollowUpSlotCandidates,
} from '../src/modules/job-cards/follow-up-auto-scheduler.js';

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

describe('target-first search with floor-anchored horizon', () => {
  const FLOOR_AT = new Date('2026-08-01T10:15:00.000Z');
  const TARGET_AT = new Date('2026-08-08T10:00:00.000Z');

  it('selects the exact grid-aligned target when free', () => {
    const slot = findEarliestFollowUpSlot({
      earliestAllowedAt: TARGET_AT,
      horizonAnchorAt: FLOOR_AT,
      type: 'SALES_MEETING',
      timezone: 'UTC',
      blockers: [],
    });

    expect(slot?.startsAt.toISOString()).toBe('2026-08-08T10:00:00.000Z');
  });

  it('advances to the next forward grid candidate when the target is blocked', () => {
    const slot = findEarliestFollowUpSlot({
      earliestAllowedAt: TARGET_AT,
      horizonAnchorAt: FLOOR_AT,
      type: 'SALES_MEETING',
      timezone: 'UTC',
      blockers: [{
        startsAt: new Date('2026-08-08T10:00:00.000Z'),
        endsAt: new Date('2026-08-08T11:00:00.000Z'),
      }],
    });

    expect(slot?.startsAt.toISOString()).toBe('2026-08-08T11:00:00.000Z');
  });

  it('never generates a candidate before the effective target', () => {
    const candidates = generateFollowUpSlotCandidates({
      earliestAllowedAt: TARGET_AT,
      horizonAnchorAt: FLOOR_AT,
      type: 'SALES_MEETING',
      timezone: 'UTC',
    });

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.startsAt.valueOf()).toBeGreaterThanOrEqual(TARGET_AT.valueOf());
    }
    expect(candidates[0]!.startsAt.toISOString()).toBe('2026-08-08T10:00:00.000Z');
  });

  it('starts from the floor when the floor is later than the desired target', () => {
    const lateFloor = new Date('2026-08-10T10:00:00.000Z');
    const slot = findEarliestFollowUpSlot({
      earliestAllowedAt: lateFloor,
      horizonAnchorAt: FLOOR_AT,
      type: 'SALES_MEETING',
      timezone: 'UTC',
      blockers: [],
    });

    expect(slot?.startsAt.toISOString()).toBe('2026-08-10T10:00:00.000Z');
  });

  it('keeps the horizon anchored to the floor, not the target', () => {
    const candidates = generateFollowUpSlotCandidates({
      earliestAllowedAt: TARGET_AT,
      horizonAnchorAt: FLOOR_AT,
      type: 'SALES_MEETING',
      timezone: 'UTC',
    });
    const floorHorizonAt = new Date('2026-08-31T10:15:00.000Z');

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.startsAt.valueOf()).toBeLessThan(floorHorizonAt.valueOf());
    }
    const last = candidates[candidates.length - 1]!;
    expect(last.startsAt.toISOString()).toBe('2026-08-31T10:00:00.000Z');
  });

  it('returns no candidate when the effective target is at or beyond the floor-anchored horizon', () => {
    const candidates = generateFollowUpSlotCandidates({
      earliestAllowedAt: new Date('2026-09-05T10:00:00.000Z'),
      horizonAnchorAt: FLOOR_AT,
      type: 'SALES_MEETING',
      timezone: 'UTC',
    });

    expect(candidates).toEqual([]);
    expect(findEarliestFollowUpSlot({
      earliestAllowedAt: new Date('2026-09-05T10:00:00.000Z'),
      horizonAnchorAt: FLOOR_AT,
      type: 'SALES_MEETING',
      timezone: 'UTC',
      blockers: [],
    })).toBeNull();
  });

  it('allows a back-to-back slot ending exactly at the target start', () => {
    const slot = findEarliestFollowUpSlot({
      earliestAllowedAt: TARGET_AT,
      horizonAnchorAt: FLOOR_AT,
      type: 'SALES_MEETING',
      timezone: 'UTC',
      blockers: [{
        startsAt: new Date('2026-08-08T09:00:00.000Z'),
        endsAt: new Date('2026-08-08T10:00:00.000Z'),
      }],
    });

    expect(slot?.startsAt.toISOString()).toBe('2026-08-08T10:00:00.000Z');
  });

  it('returns no slot when every slot until the floor-anchored horizon is blocked', () => {
    const slot = findEarliestFollowUpSlot({
      earliestAllowedAt: TARGET_AT,
      horizonAnchorAt: FLOOR_AT,
      type: 'SALES_MEETING',
      timezone: 'UTC',
      blockers: [{
        startsAt: new Date('2026-08-08T10:00:00.000Z'),
        endsAt: new Date('2026-08-31T10:15:00.000Z'),
      }],
    });

    expect(slot).toBeNull();
  });

  it('skips nonexistent spring-forward wall clocks from a target start', () => {
    // 2026-03-08 America/New_York springs forward: local 02:00-02:59 does not
    // exist. The 02:xx grid slots all resolve to 03:xx and are skipped, so a
    // blocker ending at 02:00 EST lands exactly on 03:00 EDT (07:00Z).
    const slot = findEarliestFollowUpSlot({
      earliestAllowedAt: new Date('2026-03-08T06:30:00.000Z'),
      horizonAnchorAt: new Date('2026-03-01T06:30:00.000Z'),
      type: 'SALES_MEETING',
      timezone: 'America/New_York',
      blockers: [{
        startsAt: new Date('2026-03-08T06:30:00.000Z'),
        endsAt: new Date('2026-03-08T07:00:00.000Z'),
      }],
    });

    expect(slot?.startsAt.toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  it('resolves repeated fall-back wall clocks deterministically from a target start', () => {
    const input = {
      earliestAllowedAt: new Date('2026-11-08T05:00:00.000Z'),
      horizonAnchorAt: new Date('2026-11-01T05:00:00.000Z'),
      type: 'SALES_MEETING' as const,
      timezone: 'America/New_York',
      blockers: [],
    };
    const first = findEarliestFollowUpSlot(input);
    const second = findEarliestFollowUpSlot(input);

    expect(second).toEqual(first);
    expect(first!.startsAt.valueOf()).toBeGreaterThanOrEqual(input.earliestAllowedAt.valueOf());
  });
});
