import { describe, expect, it } from 'vitest';

import {
  isCurrentlyOverdueByDate,
  isCurrentlyOverdueByInstant,
  latenessSecondsFor,
  overdueSinceFor,
} from '../src/modules/job-cards/overdue-contract.js';
import type { JobCardStatus } from '../src/modules/job-cards/types.js';

const ACTIVE: JobCardStatus[] = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
];
const TERMINAL: JobCardStatus[] = ['COMPLETED', 'CANCELLED', 'INVALIDATED'];

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
          for (const instant of probeInstants(dueDate, timezone)) {
            expect({
              dueDate, timezone, status, instant: instant.toISOString(),
              byInstant: isCurrentlyOverdueByInstant(dueDate, status, instant, timezone),
            }).toEqual({
              dueDate, timezone, status, instant: instant.toISOString(),
              byInstant: isCurrentlyOverdueByDate(dueDate, status, instant, timezone),
            });
          }
        }
      }
    }
  });

  it('pins due yesterday, due today and due tomorrow against one fixed request instant', () => {
    const timezone = 'Europe/Istanbul';
    // 2026-07-14 15:00 in Europe/Istanbul.
    const instant = new Date('2026-07-14T12:00:00.000Z');
    expect(isCurrentlyOverdueByInstant('2026-07-13', 'ACCEPTED', instant, timezone)).toBe(true);
    expect(isCurrentlyOverdueByInstant('2026-07-14', 'ACCEPTED', instant, timezone)).toBe(false);
    expect(isCurrentlyOverdueByInstant('2026-07-15', 'ACCEPTED', instant, timezone)).toBe(false);
    expect(overdueSinceFor('2026-07-13', timezone).toISOString()).toBe('2026-07-13T21:00:00.000Z');
    expect(latenessSecondsFor('2026-07-13', instant, timezone)).toBe(54_000);
  });

  it('never becomes overdue before the organization-local midnight after the due date', () => {
    const timezone = 'Europe/Istanbul';
    const since = overdueSinceFor('2026-07-13', timezone);
    expect(isCurrentlyOverdueByInstant('2026-07-13', 'ACCEPTED', new Date(since.getTime() - 1), timezone))
      .toBe(false);
    expect(isCurrentlyOverdueByInstant('2026-07-13', 'ACCEPTED', since, timezone)).toBe(true);
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
      expect(isCurrentlyOverdueByInstant('2026-07-13', status, instant, timezone)).toBe(true);
    }
    for (const status of TERMINAL) {
      expect(isCurrentlyOverdueByInstant('2026-07-13', status, instant, timezone)).toBe(false);
    }
    expect(isCurrentlyOverdueByInstant(null, 'ACCEPTED', instant, timezone)).toBe(false);
    expect(isCurrentlyOverdueByDate(null, 'ACCEPTED', instant, timezone)).toBe(false);
  });
});
