import { describe, expect, it } from 'vitest';

import {
  isCurrentlyOverdueByDate,
  isCurrentlyOverdueByInstant,
  latenessSecondsFor,
  overdueSinceFor,
} from '../src/modules/job-cards/overdue-contract.js';
import type { JobCardStatus, JobCardType } from '../src/modules/job-cards/types.js';

const ACTIVE: JobCardStatus[] = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
];
const TERMINAL: JobCardStatus[] = ['COMPLETED', 'CANCELLED', 'INVALIDATED'];
const PRODUCTIVE_TYPES: JobCardType[] = ['PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING'];

const ZONES = ['Europe/Istanbul', 'Europe/Berlin', 'Asia/Tokyo', 'UTC', 'America/New_York'];

/** Instants that bracket the organization-local midnight after each due date. */
function probeInstants(dueDate: string, timezone: string): Date[] {
  const since = overdueSinceFor(dueDate, timezone).getTime();
  return [
    since - 86_400_000,
    since - 1,
    since,
    since + 1,
    since + 43_200_000,
    since + 86_400_000,
  ].map((value) => new Date(value));
}

describe('current overdue contract', () => {
  it('keeps the shipped date form and the instant form equivalent at every probe', () => {
    const dueDates = [
      '2026-07-13', '2026-07-14', '2026-07-15', '2026-12-31', '2027-01-01',
      '2026-03-28', '2026-03-29', '2026-10-24', '2026-10-25',
    ];
    for (const timezone of ZONES) {
      for (const dueDate of dueDates) {
        for (const status of ACTIVE) {
          for (const jobType of [...PRODUCTIVE_TYPES, 'WEEKLY_REPORT' as const]) {
            for (const instant of probeInstants(dueDate, timezone)) {
              expect({
                dueDate, timezone, status, jobType, instant: instant.toISOString(),
                byInstant: isCurrentlyOverdueByInstant(dueDate, status, jobType, instant, timezone),
              }).toEqual({
                dueDate, timezone, status, jobType, instant: instant.toISOString(),
                byInstant: isCurrentlyOverdueByDate(dueDate, status, jobType, instant, timezone),
              });
            }
          }
        }
      }
    }
  });

  it('pins due yesterday, due today and due tomorrow against one fixed request instant', () => {
    const timezone = 'Europe/Istanbul';
    // 2026-07-14 15:00 in Europe/Istanbul.
    const instant = new Date('2026-07-14T12:00:00.000Z');
    expect(isCurrentlyOverdueByInstant('2026-07-13', 'ACCEPTED', 'GENERAL_TASK', instant, timezone)).toBe(true);
    expect(isCurrentlyOverdueByInstant('2026-07-14', 'ACCEPTED', 'GENERAL_TASK', instant, timezone)).toBe(false);
    expect(isCurrentlyOverdueByInstant('2026-07-15', 'ACCEPTED', 'GENERAL_TASK', instant, timezone)).toBe(false);
    expect(overdueSinceFor('2026-07-13', timezone).toISOString()).toBe('2026-07-13T21:00:00.000Z');
    expect(latenessSecondsFor('2026-07-13', instant, timezone)).toBe(54_000);
  });

  it('never becomes overdue before the organization-local midnight after the due date', () => {
    const timezone = 'Europe/Istanbul';
    const since = overdueSinceFor('2026-07-13', timezone);
    expect(isCurrentlyOverdueByInstant('2026-07-13', 'ACCEPTED', 'GENERAL_TASK', new Date(since.getTime() - 1), timezone))
      .toBe(false);
    expect(isCurrentlyOverdueByInstant('2026-07-13', 'ACCEPTED', 'GENERAL_TASK', since, timezone)).toBe(true);
    expect(latenessSecondsFor('2026-07-13', since, timezone)).toBe(0);
    expect(latenessSecondsFor('2026-07-13', new Date(since.getTime() + 3_600_000), timezone)).toBe(3_600);
  });

  it('maps the organization-local next midnight instead of a UTC day shift', () => {
    expect(overdueSinceFor('2026-07-13', 'Europe/Istanbul').toISOString())
      .toBe('2026-07-13T21:00:00.000Z');
    expect(overdueSinceFor('2026-07-13', 'Europe/Berlin').toISOString())
      .toBe('2026-07-13T22:00:00.000Z');
    expect(overdueSinceFor('2026-07-13', 'Asia/Tokyo').toISOString())
      .toBe('2026-07-13T15:00:00.000Z');
    expect(overdueSinceFor('2026-07-13', 'UTC').toISOString())
      .toBe('2026-07-14T00:00:00.000Z');
  });

  it('honours the organization DST transition on both edges', () => {
    // Europe/Berlin switches to CEST on 2026-03-29 and back to CET on 2026-10-25.
    expect(overdueSinceFor('2026-03-28', 'Europe/Berlin').toISOString())
      .toBe('2026-03-28T23:00:00.000Z');
    expect(overdueSinceFor('2026-03-29', 'Europe/Berlin').toISOString())
      .toBe('2026-03-29T22:00:00.000Z');
    expect(overdueSinceFor('2026-10-24', 'Europe/Berlin').toISOString())
      .toBe('2026-10-24T22:00:00.000Z');
    expect(overdueSinceFor('2026-10-25', 'Europe/Berlin').toISOString())
      .toBe('2026-10-25T23:00:00.000Z');
  });

  it('excludes terminal statuses and rows without a due date', () => {
    const timezone = 'Europe/Istanbul';
    const instant = new Date('2026-07-14T12:00:00.000Z');
    for (const status of ACTIVE) {
      for (const jobType of PRODUCTIVE_TYPES) {
        expect(isCurrentlyOverdueByInstant('2026-07-13', status, jobType, instant, timezone)).toBe(true);
      }
    }
    for (const status of TERMINAL) {
      expect(isCurrentlyOverdueByInstant('2026-07-13', status, 'GENERAL_TASK', instant, timezone)).toBe(false);
    }
    expect(isCurrentlyOverdueByInstant(null, 'ACCEPTED', 'GENERAL_TASK', instant, timezone)).toBe(false);
    expect(isCurrentlyOverdueByDate(null, 'ACCEPTED', 'GENERAL_TASK', instant, timezone)).toBe(false);
  });

  it('exempts submitted weekly reports from employee submission lateness', () => {
    const timezone = 'Europe/Istanbul';
    const instant = new Date('2026-07-14T12:00:00.000Z');
    // Past-due weekly report awaiting manager review: the employee submitted
    // on time (or late, already recorded at submit); review delay belongs to
    // the APPROVAL_WAIT episode, not the current-overdue condition.
    expect(isCurrentlyOverdueByInstant('2026-07-13', 'WAITING_APPROVAL', 'WEEKLY_REPORT', instant, timezone))
      .toBe(false);
    expect(isCurrentlyOverdueByDate('2026-07-13', 'WAITING_APPROVAL', 'WEEKLY_REPORT', instant, timezone))
      .toBe(false);
    // Productive types in review stay overdue-eligible (unchanged behavior).
    for (const jobType of PRODUCTIVE_TYPES) {
      expect(isCurrentlyOverdueByInstant('2026-07-13', 'WAITING_APPROVAL', jobType, instant, timezone))
        .toBe(true);
      expect(isCurrentlyOverdueByDate('2026-07-13', 'WAITING_APPROVAL', jobType, instant, timezone))
        .toBe(true);
    }
    // Weekly reports in every other active status keep the generic rule.
    for (const status of ['NEW', 'ACCEPTED', 'IN_PROGRESS', 'REVISION_REQUESTED'] as const) {
      expect(isCurrentlyOverdueByInstant('2026-07-13', status, 'WEEKLY_REPORT', instant, timezone))
        .toBe(true);
      expect(isCurrentlyOverdueByDate('2026-07-13', status, 'WEEKLY_REPORT', instant, timezone))
        .toBe(true);
    }
  });
});
