import { describe, expect, it } from 'vitest';

import { generateAvailableSlotCandidates } from '../src/modules/job-cards/available-slots.js';
import {
  findEarliestFollowUpSlot,
  generateFollowUpSlotCandidates,
} from '../src/modules/job-cards/follow-up-auto-scheduler.js';
import { suggestedFollowUpInstant } from '../src/modules/job-cards/follow-up-policy.js';
import { localDateKey } from '../src/modules/job-cards/local-calendar.js';
import { evaluateCustomerSchedule } from '../src/modules/job-cards/customer-schedule.js';

/**
 * WORKING-DAY CONTRACT RECONCILIATION — SYSTEM / AUTOMATIC side.
 *
 * The authoritative product rule splits the Sunday rule by WHO is choosing the
 * time:
 *
 *   SYSTEM / AUTOMATIC  -> Sunday is NOT selectable. Skip it or advance to the
 *                          next valid day. Never advertise Sunday, never return
 *                          Sunday, never let a canonical interval spill from
 *                          Saturday into Sunday.
 *   HUMAN / MANUAL      -> Sunday IS allowed. Explicit human writes are never
 *                          rejected and never silently moved.
 *
 * These cases are pure (no database) and pin the automatic behaviour that the
 * reconciliation must PRESERVE. They are green on the pre-reconciliation tree
 * by design: this file is the regression fence around the removal of the
 * misplaced human-side enforcement, not a RED probe. The RED probe for the
 * human side lives in `working-day-contract-human-sunday-postgres.test.ts`.
 *
 * Calendar fixtures (organization timezone UTC unless stated):
 *   2026-09-05 = Saturday    2026-09-06 = Sunday
 *   2026-09-11 = Friday      2026-09-12 = Saturday
 *   2026-09-13 = Sunday      2026-09-14 = Monday
 *   2026-09-15 = Tuesday     2026-09-16 = Wednesday
 *
 * Canonical durations: SALES_MEETING = 60m, PRODUCT_DELIVERY = 30m.
 */

const SAT = '2026-09-12';
const SUN = '2026-09-13';
const MON = '2026-09-14';
const HOUR_MS = 60 * 60 * 1000;

const dateKeysOf = (candidates: readonly { startsAt: Date }[], timezone = 'UTC') =>
  candidates.map((candidate) => localDateKey(candidate.startsAt, timezone));

describe('WORKING-DAY contract — SYSTEM: the +7 canonical follow-up target advances off Sunday', () => {
  it('7a: advances an ordinary Sunday target to the following Monday', () => {
    // 2026-09-06 + 7 calendar days = 2026-09-13, an organization-local Sunday.
    const instant = suggestedFollowUpInstant({
      evaluatedAt: new Date('2026-09-06T10:00:00.000Z'),
      sourceScheduledAt: null,
      timezone: 'UTC',
      durationMs: HOUR_MS,
    });
    expect(instant.toISOString()).toBe(`${MON}T10:00:00.000Z`);
  });

  it('7b: advances a degenerate (point) Sunday target to the following Monday', () => {
    const instant = suggestedFollowUpInstant({
      evaluatedAt: new Date('2026-09-06T10:00:00.000Z'),
      sourceScheduledAt: null,
      timezone: 'UTC',
    });
    expect(instant.toISOString()).toBe(`${MON}T10:00:00.000Z`);
  });

  it('7c: advances a late-Saturday target whose canonical duration spills into Sunday', () => {
    // 2026-09-05 + 7 = 2026-09-12 at 23:30; +60m crosses local midnight into
    // Sunday, so the whole interval moves to Monday at the same wall clock.
    const instant = suggestedFollowUpInstant({
      evaluatedAt: new Date('2026-09-05T23:30:00.000Z'),
      sourceScheduledAt: null,
      timezone: 'UTC',
      durationMs: HOUR_MS,
    });
    expect(instant.toISOString()).toBe(`${MON}T23:30:00.000Z`);
  });

  it('7d: decides Sunday in the ORGANIZATION timezone, not UTC', () => {
    // The +7 target of 2026-09-05T21:30Z is 2026-09-12T21:30Z. In
    // Europe/Istanbul (UTC+3) that wall clock is 2026-09-13 00:30 local — an
    // organization-local Sunday — so it must advance one local day to
    // 2026-09-14 00:30 local (= 2026-09-13T21:30Z). The same instant is still
    // Saturday in UTC and must be left untouched there.
    const istanbul = suggestedFollowUpInstant({
      evaluatedAt: new Date('2026-09-05T21:30:00.000Z'),
      sourceScheduledAt: null,
      timezone: 'Europe/Istanbul',
      durationMs: HOUR_MS,
    });
    expect(istanbul.toISOString()).toBe('2026-09-13T21:30:00.000Z');
    expect(localDateKey(istanbul, 'Europe/Istanbul')).toBe(MON);

    const utc = suggestedFollowUpInstant({
      evaluatedAt: new Date('2026-09-05T21:30:00.000Z'),
      sourceScheduledAt: null,
      timezone: 'UTC',
      durationMs: HOUR_MS,
    });
    expect(utc.toISOString()).toBe(`${SAT}T21:30:00.000Z`);
  });
});

describe('WORKING-DAY contract — SYSTEM: the automatic follow-up candidate iterator skips Sunday', () => {
  it('8a: starts at Monday when the requested window begins on Sunday', () => {
    const first = findEarliestFollowUpSlot({
      earliestAllowedAt: new Date(`${SUN}T00:00:00.000Z`),
      type: 'SALES_MEETING',
      timezone: 'UTC',
      blockers: [],
    });
    expect(first?.startsAt.toISOString()).toBe(`${MON}T00:00:00.000Z`);
  });

  it('8b: never yields a Sunday candidate anywhere in the generated horizon', () => {
    const candidates = generateFollowUpSlotCandidates({
      earliestAllowedAt: new Date(`${SAT}T00:00:00.000Z`),
      horizonAnchorAt: new Date(`${SAT}T00:00:00.000Z`),
      type: 'SALES_MEETING',
      timezone: 'UTC',
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(dateKeysOf(candidates)).not.toContain(SUN);
    // The skip removes Sunday only: Saturday and Monday are still advertised.
    expect(dateKeysOf(candidates)).toContain(SAT);
    expect(dateKeysOf(candidates)).toContain(MON);
  });
});

describe('WORKING-DAY contract — SYSTEM: generated available-slot candidates never advertise Sunday', () => {
  it('9a: skips the whole Sunday date and keeps every other day', () => {
    const candidates = generateAvailableSlotCandidates({
      startsAt: new Date(`${SAT}T09:00:00.000Z`),
      endsAt: new Date(`${SAT}T10:00:00.000Z`),
      timezone: 'UTC',
      horizonDays: 4,
    });
    // Day offsets 1..4 from Saturday: Sunday is dropped, the rest survive.
    expect(dateKeysOf(candidates)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
  });

  it('9b: drops a Friday candidate whose duration spills into Saturday-then-Sunday', () => {
    // Friday 23:30 + 60m lands on Saturday, but the day-1 candidate is
    // Saturday 23:30 -> Sunday 00:30 and must not be advertised.
    const candidates = generateAvailableSlotCandidates({
      startsAt: new Date('2026-09-11T23:30:00.000Z'),
      endsAt: new Date(`${SAT}T00:30:00.000Z`),
      timezone: 'UTC',
      horizonDays: 3,
    });
    expect(dateKeysOf(candidates)).toEqual(['2026-09-14']);
    expect(candidates[0]!.startsAt.toISOString()).toBe(`${MON}T23:30:00.000Z`);
  });
});

describe('WORKING-DAY contract — SYSTEM: the automatic alternative-slot search never proposes Sunday', () => {
  it('10a: returns Monday as the earliest alternative when the window opens on Sunday', () => {
    const alternative = findEarliestFollowUpSlot({
      earliestAllowedAt: new Date(`${SUN}T00:00:00.000Z`),
      type: 'SALES_MEETING',
      timezone: 'UTC',
      blockers: [],
    });
    expect(alternative?.startsAt.toISOString()).toBe(`${MON}T00:00:00.000Z`);
  });

  it('10b: skips past a fully blocked Saturday to Monday instead of proposing Sunday', () => {
    const alternative = findEarliestFollowUpSlot({
      earliestAllowedAt: new Date(`${SAT}T00:00:00.000Z`),
      type: 'SALES_MEETING',
      timezone: 'UTC',
      blockers: [{
        startsAt: new Date(`${SAT}T00:00:00.000Z`),
        endsAt: new Date(`${SUN}T00:00:00.000Z`),
      }],
    });
    expect(alternative?.startsAt.toISOString()).toBe(`${MON}T00:00:00.000Z`);
  });

  it('10c: keeps the reserved suggestedAlternativeAt projection free of Sunday', async () => {
    // `suggestedAlternativeAt` is a reserved projection field that production
    // does not populate yet (always null); the automatic alternative the
    // product actually surfaces today is `findEarliestFollowUpSlot` above.
    // Pin the field so a future producer cannot start emitting Sunday silently.
    const evaluation = await evaluateCustomerSchedule({
      reader: {
        getOrganizationTimezone: async () => 'UTC',
        listActiveOnSiteJobs: async () => [],
        listRecentOnSiteVisits: async () => [],
      },
      organizationId: 'wd-contract-system',
      customerId: null,
      proposedAt: new Date(`${SUN}T10:00:00.000Z`),
      jobType: 'SALES_MEETING',
      now: new Date(`${SAT}T10:00:00.000Z`),
    });
    if (evaluation.suggestedAlternativeAt !== null) {
      expect(localDateKey(new Date(evaluation.suggestedAlternativeAt), 'UTC')).not.toBe(SUN);
    } else {
      expect(evaluation.suggestedAlternativeAt).toBeNull();
    }
  });
});

describe('WORKING-DAY contract — SYSTEM: an automatic interval spilling from Saturday into Sunday is skipped', () => {
  it('11: drops every late-Saturday candidate whose duration crosses local midnight', () => {
    const candidates = generateFollowUpSlotCandidates({
      earliestAllowedAt: new Date(`${SAT}T23:00:00.000Z`),
      horizonAnchorAt: new Date(`${SAT}T23:00:00.000Z`),
      type: 'SALES_MEETING',
      timezone: 'UTC',
    });
    const lateSaturday = candidates.filter(
      (candidate) => localDateKey(candidate.startsAt, 'UTC') === SAT,
    );
    // 23:00 -> 00:00 is half-open and still inside Saturday; the 23:15/23:30/
    // 23:45 grid points spill past local midnight and are all skipped.
    expect(lateSaturday.map((candidate) => candidate.startsAt.toISOString()))
      .toEqual([`${SAT}T23:00:00.000Z`]);
    expect(lateSaturday[0]!.endsAt.toISOString()).toBe(`${SUN}T00:00:00.000Z`);
  });
});
