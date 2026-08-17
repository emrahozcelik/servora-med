import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cardScheduleFact,
  canonicalPreviewEndLocal,
  defaultScheduledLocalValue,
  localDateTimeToIso,
  shiftInterval,
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

describe('canonicalPreviewEndLocal', () => {
  it('previews a 60-minute Sales Meeting interval', () => {
    expect(canonicalPreviewEndLocal('2026-08-01T23:30', 'SALES_MEETING'))
      .toBe('2026-08-02T00:30');
  });

  it('previews a 30-minute Product Delivery interval', () => {
    expect(canonicalPreviewEndLocal('2026-08-01T23:30', 'PRODUCT_DELIVERY'))
      .toBe('2026-08-02T00:00');
  });
});

describe('cardScheduleFact', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prefers scheduledAt over dueDate with type-specific labels', () => {
    const delivery = cardScheduleFact({
      type: 'PRODUCT_DELIVERY',
      scheduledAt: '2026-07-20T09:00:00.000Z',
      dueDate: '2026-07-25',
    });
    expect(delivery.label).toBe('Planlanan teslim');
    expect(delivery.dateTime).toBe('2026-07-20T09:00:00.000Z');
    expect(delivery.text.length).toBeGreaterThan(0);

    const meeting = cardScheduleFact({
      type: 'SALES_MEETING',
      scheduledAt: '2026-07-21T11:30:00.000Z',
      dueDate: '2026-07-21',
    });
    expect(meeting.label).toBe('Planlanan görüşme');
    expect(meeting.dateTime).toBe('2026-07-21T11:30:00.000Z');
  });

  it('labels same-day delivery and task as Bugün HH:mm with injectable now', () => {
    const now = localDate('2026-07-17T12:00');
    // Construct an ISO that lands on local 2026-07-17 14:30
    const todayIso = localDateTimeToIso('2026-07-17T14:30');
    const delivery = cardScheduleFact({
      type: 'PRODUCT_DELIVERY',
      scheduledAt: todayIso,
      dueDate: null,
    }, now);
    expect(delivery.label).toBe('Bugün');
    expect(delivery.dateTime).toBe(todayIso);
    expect(delivery.text).toMatch(/\d{2}:\d{2}/);

    const task = cardScheduleFact({
      type: 'GENERAL_TASK',
      scheduledAt: todayIso,
      dueDate: null,
    }, now);
    expect(task.label).toBe('Bugün');

    // Sales Meeting keeps Planlanan görüşme even on the same calendar day.
    const meeting = cardScheduleFact({
      type: 'SALES_MEETING',
      scheduledAt: todayIso,
      dueDate: null,
    }, now);
    expect(meeting.label).toBe('Planlanan görüşme');
  });

  it('falls back to dueDate when scheduledAt is null', () => {
    expect(cardScheduleFact({
      type: 'PRODUCT_DELIVERY', scheduledAt: null, dueDate: '2026-07-20',
    })).toMatchObject({
      label: 'Termin',
      dateTime: '2026-07-20',
    });
    expect(cardScheduleFact({
      type: 'SALES_MEETING', scheduledAt: null, dueDate: '2026-07-20',
    })).toMatchObject({
      label: 'Planlanan görüşme günü',
      dateTime: '2026-07-20',
    });
    expect(cardScheduleFact({
      type: 'GENERAL_TASK', scheduledAt: null, dueDate: null,
    })).toEqual({
      label: 'Termin',
      text: 'Belirtilmedi',
      dateTime: null,
    });
  });
});

describe('shiftInterval', () => {
  it('moves the whole interval preserving the original duration', () => {
    expect(shiftInterval('2026-08-01T12:30', '2026-08-01T13:30', '2026-08-10T09:30'))
      .toEqual(['2026-08-10T09:30', '2026-08-10T10:30']);
  });

  it('preserves multi-hour durations', () => {
    expect(shiftInterval('2026-08-01T10:00', '2026-08-01T14:00', '2026-08-03T08:00'))
      .toEqual(['2026-08-03T08:00', '2026-08-03T12:00']);
  });

  it('preserves durations that cross midnight', () => {
    expect(shiftInterval('2026-08-01T23:00', '2026-08-02T01:00', '2026-08-05T09:00'))
      .toEqual(['2026-08-05T09:00', '2026-08-05T11:00']);
  });

  it('keeps the new start exactly as given and formats both ends as YYYY-MM-DDTHH:mm', () => {
    const [start, end] = shiftInterval('2026-08-01T12:30', '2026-08-01T13:30', '2026-08-10T09:30');
    expect(start).toBe('2026-08-10T09:30');
    expect(end).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});
