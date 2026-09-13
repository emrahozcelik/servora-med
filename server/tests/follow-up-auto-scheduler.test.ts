import { describe, expect, it } from 'vitest';

import {
  findEarliestFollowUpSlot,
  generateFollowUpSlotCandidates,
  isFollowUpSlotBlocked,
  iterateFollowUpSlotCandidates,
  resolveFollowUpSearchHorizonAt,
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

describe('iterateFollowUpSlotCandidates', () => {
  function expectIteratorParity(input: {
    earliestAllowedAt: Date;
    horizonAnchorAt?: Date;
    type: 'SALES_MEETING' | 'PRODUCT_DELIVERY' | 'GENERAL_TASK';
    timezone: string;
  }) {
    const materialized = generateFollowUpSlotCandidates(input);
    const streamed = Array.from(iterateFollowUpSlotCandidates(input));
    expect(streamed.map((c) => [c.startsAt.toISOString(), c.endsAt.toISOString()])).toEqual(
      materialized.map((c) => [c.startsAt.toISOString(), c.endsAt.toISOString()]),
    );
    return materialized;
  }

  it('streams the identical UTC sequence without requiring full-list semantics', () => {
    const input = {
      earliestAllowedAt: new Date('2026-08-01T10:07:00.000Z'),
      type: 'SALES_MEETING' as const,
      timezone: 'UTC',
    };
    const materialized = expectIteratorParity(input);
    expect(materialized.length).toBe(2880);

    const iterator = iterateFollowUpSlotCandidates(input);
    const first = iterator.next();
    expect(first.done).toBe(false);
    expect(first.value!.startsAt.toISOString()).toBe(materialized[0]!.startsAt.toISOString());
    expect(first.value!.endsAt.toISOString()).toBe(materialized[0]!.endsAt.toISOString());
  });

  it('preserves PRODUCT_DELIVERY duration and GENERAL_TASK emptiness', () => {
    const product = expectIteratorParity({
      earliestAllowedAt: new Date('2026-08-01T10:00:00.000Z'),
      type: 'PRODUCT_DELIVERY',
      timezone: 'UTC',
    });
    expect(product.length).toBeGreaterThan(0);
    for (const candidate of product) {
      expect(candidate.endsAt.valueOf() - candidate.startsAt.valueOf()).toBe(30 * 60 * 1000);
    }
    expect(Array.from(iterateFollowUpSlotCandidates({
      earliestAllowedAt: new Date('2026-08-01T10:00:00.000Z'),
      type: 'GENERAL_TASK',
      timezone: 'UTC',
    }))).toEqual([]);
  });

  it('matches materialized output across spring-forward', () => {
    const materialized = expectIteratorParity({
      earliestAllowedAt: new Date('2026-03-08T06:30:00.000Z'),
      horizonAnchorAt: new Date('2026-03-01T06:30:00.000Z'),
      type: 'SALES_MEETING',
      timezone: 'America/New_York',
    });
    for (let i = 1; i < materialized.length; i += 1) {
      expect(materialized[i]!.startsAt.valueOf()).toBeGreaterThan(materialized[i - 1]!.startsAt.valueOf());
    }
  });

  it('matches materialized output across fall-back', () => {
    expectIteratorParity({
      earliestAllowedAt: new Date('2026-11-01T04:58:00.000Z'),
      type: 'SALES_MEETING',
      timezone: 'America/New_York',
    });
  });

  it('matches materialized output across a half-hour Lord Howe transition', () => {
    // Lord Howe springs forward 02:00 -> 02:30 on 2026-10-04 (30-minute shift).
    const materialized = expectIteratorParity({
      earliestAllowedAt: new Date('2026-10-03T14:00:00.000Z'),
      type: 'SALES_MEETING',
      timezone: 'Australia/Lord_Howe',
    });
    expect(materialized.length).toBeGreaterThan(0);
    for (const candidate of materialized) {
      expect(candidate.endsAt.valueOf() - candidate.startsAt.valueOf()).toBe(60 * 60 * 1000);
    }
  });

  it('keeps the horizon anchored to the floor for target-first search', () => {
    const materialized = expectIteratorParity({
      earliestAllowedAt: new Date('2026-08-08T10:00:00.000Z'),
      horizonAnchorAt: new Date('2026-08-01T10:15:00.000Z'),
      type: 'SALES_MEETING',
      timezone: 'UTC',
    });
    const horizonAt = resolveFollowUpSearchHorizonAt(new Date('2026-08-01T10:15:00.000Z'), 'UTC');
    expect(horizonAt.toISOString()).toBe('2026-08-31T10:15:00.000Z');
    const last = materialized[materialized.length - 1]!;
    expect(last.startsAt.valueOf()).toBeLessThan(horizonAt.valueOf());
    expect(horizonAt.valueOf() - last.startsAt.valueOf()).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it('yields nothing when the effective target is at or beyond the horizon', () => {
    expect(Array.from(iterateFollowUpSlotCandidates({
      earliestAllowedAt: new Date('2026-09-05T10:00:00.000Z'),
      horizonAnchorAt: new Date('2026-08-01T10:15:00.000Z'),
      type: 'SALES_MEETING',
      timezone: 'UTC',
    }))).toEqual([]);
  });
});

describe('isFollowUpSlotBlocked', () => {
  const candidate = {
    startsAt: new Date('2026-08-01T10:00:00.000Z'),
    endsAt: new Date('2026-08-01T11:00:00.000Z'),
  };

  it('detects overlap', () => {
    expect(isFollowUpSlotBlocked(candidate, [{
      startsAt: new Date('2026-08-01T10:30:00.000Z'),
      endsAt: new Date('2026-08-01T11:30:00.000Z'),
    }])).toBe(true);
  });

  it('allows exactly back-to-back intervals on both sides', () => {
    expect(isFollowUpSlotBlocked(candidate, [{
      startsAt: new Date('2026-08-01T09:00:00.000Z'),
      endsAt: new Date('2026-08-01T10:00:00.000Z'),
    }])).toBe(false);
    expect(isFollowUpSlotBlocked(candidate, [{
      startsAt: new Date('2026-08-01T11:00:00.000Z'),
      endsAt: new Date('2026-08-01T12:00:00.000Z'),
    }])).toBe(false);
  });

  it('reports clear when nothing overlaps', () => {
    expect(isFollowUpSlotBlocked(candidate, [])).toBe(false);
  });
});
