import { describe, expect, it } from 'vitest';

import {
  defaultScheduledLocalValue,
  localDateTimeToIso,
} from '../src/jobs/scheduling';

/** Build a Date from local wall-clock components (not UTC). */
function localDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error(`invalid localDate fixture: ${value}`);
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    match[6] ? Number(match[6]) : 0,
    0,
  );
}

describe('defaultScheduledLocalValue', () => {
  it('adds one hour then rounds up to the next 30-minute boundary', () => {
    expect(defaultScheduledLocalValue(localDate('2026-07-17T13:04')))
      .toBe('2026-07-17T14:30');
    expect(defaultScheduledLocalValue(localDate('2026-07-17T13:24')))
      .toBe('2026-07-17T14:30');
    expect(defaultScheduledLocalValue(localDate('2026-07-17T13:48')))
      .toBe('2026-07-17T15:00');
  });

  it('keeps an exact 30-minute boundary after the +1h step', () => {
    expect(defaultScheduledLocalValue(localDate('2026-07-17T13:00')))
      .toBe('2026-07-17T14:00');
    expect(defaultScheduledLocalValue(localDate('2026-07-17T12:30')))
      .toBe('2026-07-17T13:30');
  });

  it('rolls over to the next local calendar day', () => {
    expect(defaultScheduledLocalValue(localDate('2026-07-17T23:20')))
      .toBe('2026-07-18T00:30');
    expect(defaultScheduledLocalValue(localDate('2026-12-31T23:40')))
      .toBe('2027-01-01T01:00');
  });

  it('rounds up leftover seconds before the 30-minute ceiling', () => {
    expect(defaultScheduledLocalValue(localDate('2026-07-17T13:00:01')))
      .toBe('2026-07-17T14:30');
  });
});

describe('localDateTimeToIso', () => {
  it('converts a device-local datetime-local value to a UTC instant with Z', () => {
    const local = '2026-07-17T14:30';
    const iso = localDateTimeToIso(local);
    expect(iso.endsWith('Z')).toBe(true);
    expect(new Date(iso).getTime()).toBe(localDate(local).getTime());
  });

  it('round-trips through the local wall clock', () => {
    const local = '2026-03-15T09:00';
    const again = new Date(localDateTimeToIso(local));
    expect(again.getFullYear()).toBe(2026);
    expect(again.getMonth()).toBe(2);
    expect(again.getDate()).toBe(15);
    expect(again.getHours()).toBe(9);
    expect(again.getMinutes()).toBe(0);
  });
});
