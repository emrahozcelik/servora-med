import { describe, expect, it } from 'vitest';

import {
  dateKeyToOrdinal,
  isSundayDateKey,
  localDateKey,
  weekdayOfDateKey,
} from '../src/modules/job-cards/local-calendar.js';
import {
  NON_WORKING_DAY,
  NON_WORKING_DAY_SAFE_MESSAGE,
  advanceToWorkingDay,
  assertWorkingDay,
  isDegeneratePoint,
  occupiesNonWorkingDay,
} from '../src/modules/job-cards/working-day-policy.js';

const at = (iso: string) => new Date(iso);
const overlaps = (startsAt: string, endsAt: string | null, timezone: string) =>
  occupiesNonWorkingDay({ startsAt: at(startsAt), endsAt: endsAt === null ? null : at(endsAt), timezone });

// 2026-09-13 is a Sunday; 2026-09-12 Saturday; 2026-09-14 Monday.

describe('local-calendar weekday primitive', () => {
  it('anchors the ordinal epoch at Thursday 1970-01-01', () => {
    expect(dateKeyToOrdinal('1970-01-01')).toBe(0);
    expect(weekdayOfDateKey('1970-01-01')).toBe(4); // 0 = Sunday, so 4 = Thursday
  });

  it('maps every weekday correctly across a full week', () => {
    expect(weekdayOfDateKey('2026-09-13')).toBe(0); // Sunday
    expect(weekdayOfDateKey('2026-09-14')).toBe(1); // Monday
    expect(weekdayOfDateKey('2026-09-15')).toBe(2);
    expect(weekdayOfDateKey('2026-09-16')).toBe(3);
    expect(weekdayOfDateKey('2026-09-17')).toBe(4);
    expect(weekdayOfDateKey('2026-09-18')).toBe(5);
    expect(weekdayOfDateKey('2026-09-19')).toBe(6); // Saturday
  });

  it('identifies Sundays across month, year and leap boundaries', () => {
    for (const key of [
      '2026-01-04', '2026-03-08', '2026-09-06', '2026-09-13', '2026-09-20',
      '2026-11-01', '2026-10-04', '2026-12-27', '2024-02-29',
    ]) {
      expect(isSundayDateKey(key), key).toBe(new Date(`${key}T12:00:00Z`).getUTCDay() === 0);
    }
    expect(isSundayDateKey('2024-02-29')).toBe(false); // Thursday
  });

  it('agrees with the UTC day-of-week across a long span', () => {
    for (let ordinal = 0; ordinal < 400; ordinal += 1) {
      const date = new Date(Date.UTC(2026, 0, 1) + ordinal * 86_400_000);
      const key = date.toISOString().slice(0, 10);
      expect(weekdayOfDateKey(key), key).toBe(date.getUTCDay());
    }
  });
});

describe('§29 boundary contract (NO_SUNDAY_OVERLAP)', () => {
  it('allows an interval ending exactly at Sunday 00:00', () => {
    expect(overlaps('2026-09-12T23:00:00.000Z', '2026-09-13T00:00:00.000Z', 'UTC')).toBe(false);
  });

  it('denies an interval spilling into Sunday', () => {
    expect(overlaps('2026-09-12T23:30:00.000Z', '2026-09-13T00:30:00.000Z', 'UTC')).toBe(true);
  });

  it('denies an interval fully inside Sunday', () => {
    expect(overlaps('2026-09-13T00:00:00.000Z', '2026-09-13T01:00:00.000Z', 'UTC')).toBe(true);
  });

  it('denies a Sunday point', () => {
    expect(overlaps('2026-09-13T00:00:00.000Z', null, 'UTC')).toBe(true);
    expect(overlaps('2026-09-13T23:59:59.999Z', null, 'UTC')).toBe(true);
  });

  it('allows a Monday point', () => {
    expect(overlaps('2026-09-14T00:00:00.000Z', null, 'UTC')).toBe(false);
  });

  it('allows Mon–Sat points', () => {
    for (const iso of [
      '2026-09-14T00:00:00.000Z', '2026-09-15T00:00:00.000Z', '2026-09-16T00:00:00.000Z',
      '2026-09-17T00:00:00.000Z', '2026-09-18T00:00:00.000Z', '2026-09-12T00:00:00.000Z',
    ]) {
      expect(overlaps(iso, null, 'UTC'), iso).toBe(false);
    }
  });

  it('PRODUCT_DELIVERY boundary: Sat 23:30 → Sun 00:00 allowed', () => {
    expect(overlaps('2026-09-12T23:30:00.000Z', '2026-09-13T00:00:00.000Z', 'UTC')).toBe(false);
  });

  it('PRODUCT_DELIVERY boundary: Sat 23:45 → Sun 00:15 denied', () => {
    expect(overlaps('2026-09-12T23:45:00.000Z', '2026-09-13T00:15:00.000Z', 'UTC')).toBe(true);
  });

  it('denies a long interval spanning a whole week', () => {
    expect(overlaps('2026-09-14T00:00:00.000Z', '2026-09-22T00:00:00.000Z', 'UTC')).toBe(true);
  });

  it('treats a non-positive end as a point', () => {
    expect(isDegeneratePoint(at('2026-09-13T10:00:00.000Z'), null)).toBe(true);
    expect(isDegeneratePoint(at('2026-09-13T10:00:00.000Z'), at('2026-09-13T10:00:00.000Z'))).toBe(true);
    expect(isDegeneratePoint(at('2026-09-13T10:00:00.000Z'), at('2026-09-13T09:00:00.000Z'))).toBe(true);
    expect(overlaps('2026-09-13T10:00:00.000Z', '2026-09-13T10:00:00.000Z', 'UTC')).toBe(true);
  });

  it('assertWorkingDay throws the frozen error contract', () => {
    try {
      assertWorkingDay({ startsAt: at('2026-09-13T10:00:00.000Z'), endsAt: null, timezone: 'UTC' });
      throw new Error('expected NON_WORKING_DAY');
    } catch (caught) {
      expect(caught).toMatchObject({
        code: NON_WORKING_DAY,
        statusCode: 400,
        message: NON_WORKING_DAY_SAFE_MESSAGE,
      });
    }
    expect(() => assertWorkingDay({
      startsAt: at('2026-09-14T10:00:00.000Z'), endsAt: null, timezone: 'UTC',
    })).not.toThrow();
  });
});

describe('§28 organization timezone authority', () => {
  it('resolves the same instant differently per organization timezone', () => {
    const startsAt = '2026-09-12T20:30:00.000Z'; // Sat 23:30 Istanbul / Sat 20:30 UTC
    const endsAt = '2026-09-12T21:30:00.000Z';   // Sun 00:30 Istanbul / Sat 21:30 UTC
    expect(overlaps(startsAt, endsAt, 'Europe/Istanbul')).toBe(true);
    expect(overlaps(startsAt, endsAt, 'UTC')).toBe(false);
  });

  it('denies a UTC-Saturday instant that is organization-local Sunday', () => {
    // Pacific/Kiritimati is UTC+14: 2026-09-12T12:00Z is 2026-09-13 02:00 local.
    expect(localDateKey(at('2026-09-12T12:00:00.000Z'), 'Pacific/Kiritimati')).toBe('2026-09-13');
    expect(overlaps('2026-09-12T12:00:00.000Z', null, 'Pacific/Kiritimati')).toBe(true);
  });

  it('allows a UTC-Sunday instant that is organization-local Saturday', () => {
    // Pacific/Midway is UTC-11: 2026-09-13T05:00Z is 2026-09-12 18:00 local.
    expect(localDateKey(at('2026-09-13T05:00:00.000Z'), 'Pacific/Midway')).toBe('2026-09-12');
    expect(overlaps('2026-09-13T05:00:00.000Z', null, 'Pacific/Midway')).toBe(false);
  });

  it('allows a UTC-Sunday instant that is organization-local Monday', () => {
    // Pacific/Kiritimati is UTC+14: 2026-09-13T12:00Z is 2026-09-14 02:00 local.
    expect(localDateKey(at('2026-09-13T12:00:00.000Z'), 'Pacific/Kiritimati')).toBe('2026-09-14');
    expect(overlaps('2026-09-13T12:00:00.000Z', null, 'Pacific/Kiritimati')).toBe(false);
  });
});

describe('§28 DST matrix — local date keys, never fixed 24h windows', () => {
  it('Europe/Istanbul (fixed +03) Sunday boundary', () => {
    // Sunday 00:00 Istanbul = 2026-09-12T21:00Z.
    expect(overlaps('2026-09-12T20:00:00.000Z', '2026-09-12T21:00:00.000Z', 'Europe/Istanbul')).toBe(false);
    expect(overlaps('2026-09-12T21:00:00.000Z', '2026-09-12T22:00:00.000Z', 'Europe/Istanbul')).toBe(true);
  });

  it('America/New_York spring-forward Sunday is 23 hours long', () => {
    // 2026-03-08: Sunday 00:00 EST = 05:00Z; Monday 00:00 EDT = 2026-03-09T04:00Z.
    expect(overlaps('2026-03-08T04:00:00.000Z', '2026-03-08T05:00:00.000Z', 'America/New_York')).toBe(false);
    expect(overlaps('2026-03-08T05:00:00.000Z', '2026-03-08T06:00:00.000Z', 'America/New_York')).toBe(true);
    // A 24h window from 05:00Z would end at 2026-03-09T05:00Z; the true window
    // ends an hour earlier, so Monday 00:00 local must already be allowed.
    expect(overlaps('2026-03-09T04:00:00.000Z', '2026-03-09T04:30:00.000Z', 'America/New_York')).toBe(false);
  });

  it('America/New_York fall-back Sunday is 25 hours long', () => {
    // 2026-11-01: Sunday 00:00 EDT = 04:00Z; Monday 00:00 EST = 2026-11-02T05:00Z.
    expect(overlaps('2026-11-01T03:00:00.000Z', '2026-11-01T04:00:00.000Z', 'America/New_York')).toBe(false);
    expect(overlaps('2026-11-01T04:00:00.000Z', '2026-11-01T05:00:00.000Z', 'America/New_York')).toBe(true);
    // A 24h window would have ended at 2026-11-02T04:00Z and wrongly allowed
    // this Sunday 23:00 local interval.
    expect(overlaps('2026-11-02T04:00:00.000Z', '2026-11-02T04:30:00.000Z', 'America/New_York')).toBe(true);
    expect(overlaps('2026-11-02T05:00:00.000Z', '2026-11-02T05:30:00.000Z', 'America/New_York')).toBe(false);
  });

  it('Australia/Lord_Howe 30-minute DST shift on a Sunday', () => {
    // 2026-10-04: Sunday 00:00 +10:30 = 2026-10-03T13:30Z; Monday 00:00 +11 = 2026-10-04T13:00Z.
    expect(overlaps('2026-10-03T12:30:00.000Z', '2026-10-03T13:30:00.000Z', 'Australia/Lord_Howe')).toBe(false);
    expect(overlaps('2026-10-03T13:30:00.000Z', '2026-10-03T14:30:00.000Z', 'Australia/Lord_Howe')).toBe(true);
    // The true window ends at 13:00Z; a 24h window would end at 13:30Z and
    // wrongly deny this Monday 00:00 local interval.
    expect(overlaps('2026-10-04T13:00:00.000Z', '2026-10-04T13:20:00.000Z', 'Australia/Lord_Howe')).toBe(false);
  });
});

describe('advanceToWorkingDay', () => {
  it('returns an already-valid interval unchanged', () => {
    const result = advanceToWorkingDay({
      startsAt: at('2026-09-14T10:00:00.000Z'),
      endsAt: at('2026-09-14T11:00:00.000Z'),
      timezone: 'UTC',
    });
    expect(result?.startsAt.toISOString()).toBe('2026-09-14T10:00:00.000Z');
    expect(result?.endsAt?.toISOString()).toBe('2026-09-14T11:00:00.000Z');
  });

  it('advances an ordinary Sunday target to Monday, preserving wall clock', () => {
    const result = advanceToWorkingDay({
      startsAt: at('2026-09-13T10:00:00.000Z'),
      endsAt: at('2026-09-13T11:00:00.000Z'),
      timezone: 'UTC',
    });
    expect(result?.startsAt.toISOString()).toBe('2026-09-14T10:00:00.000Z');
  });

  it('advances a Saturday spill target twice to reach a valid date', () => {
    const result = advanceToWorkingDay({
      startsAt: at('2026-09-12T23:30:00.000Z'),
      endsAt: at('2026-09-13T00:30:00.000Z'),
      timezone: 'UTC',
    });
    expect(result?.startsAt.toISOString()).toBe('2026-09-14T23:30:00.000Z');
  });

  it('preserves the wall clock across a DST transition', () => {
    // Sunday 2026-03-08 01:00 EST (UTC-5) is 06:00Z; the Monday it advances to
    // is already EDT (UTC-4), so the UTC instant must move by 23h, not 24h,
    // while the local wall clock stays at 01:00.
    const result = advanceToWorkingDay({
      startsAt: at('2026-03-08T06:00:00.000Z'), // Sunday 01:00 EST
      endsAt: at('2026-03-08T07:00:00.000Z'),
      timezone: 'America/New_York',
    });
    expect(localDateKey(result!.startsAt, 'America/New_York')).toBe('2026-03-09');
    expect(localDateKey(result!.endsAt!, 'America/New_York')).toBe('2026-03-09');
    expect(result!.startsAt.toISOString()).toBe('2026-03-09T05:00:00.000Z'); // Monday 01:00 EDT
    expect(result!.endsAt!.toISOString()).toBe('2026-03-09T06:00:00.000Z'); // duration preserved
  });

  it('returns null when no valid date exists inside the bound', () => {
    const result = advanceToWorkingDay({
      startsAt: at('2026-09-13T10:00:00.000Z'),
      endsAt: at('2026-09-13T11:00:00.000Z'),
      timezone: 'UTC',
      maxDays: 0,
    });
    expect(result).toBeNull();
  });

  it('never returns a Sunday-invalid interval, whatever the shift count', () => {
    for (const span of [
      ['2026-09-13T10:00:00.000Z', '2026-09-13T11:00:00.000Z'], // Sunday point-ish interval
      ['2026-09-12T23:30:00.000Z', '2026-09-13T00:30:00.000Z'], // Saturday spill
      ['2026-09-13T22:00:00.000Z', '2026-09-14T02:00:00.000Z'], // Sunday night into Monday
      ['2026-09-18T22:00:00.000Z', '2026-09-19T02:00:00.000Z'], // Friday night into Saturday
    ]) {
      const [startsAt, endsAt] = span;
      const result = advanceToWorkingDay({
        startsAt: at(startsAt),
        endsAt: at(endsAt),
        timezone: 'UTC',
      });
      expect(result, `${startsAt} → ${endsAt}`).not.toBeNull();
      expect(
        occupiesNonWorkingDay({ startsAt: result!.startsAt, endsAt: result!.endsAt, timezone: 'UTC' }),
        `${startsAt} → ${endsAt}`,
      ).toBe(false);
    }
  });

  it('cannot satisfy an interval that spans a full week, and reports null', () => {
    // A 7-day occupied interval contains a Sunday at every shift, so the
    // bounded search must terminate with an explicit null rather than loop.
    const result = advanceToWorkingDay({
      startsAt: at('2026-09-14T10:00:00.000Z'),
      endsAt: at('2026-09-21T10:00:00.000Z'),
      timezone: 'UTC',
    });
    expect(result).toBeNull();
  });
});
