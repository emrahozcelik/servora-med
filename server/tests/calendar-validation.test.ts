import { describe, expect, it } from 'vitest';

import { parseCalendarQuery } from '../src/modules/calendar/query.js';
import {
  parseManualEventCreate,
  parseManualEventPatch,
} from '../src/modules/calendar/validation.js';

describe('calendar input contracts', () => {
  it('accepts a half-open manual interval and valid IANA timezone', () => {
    expect(parseManualEventCreate({
      clientActionId: 'create-1',
      assignedUserId: '11111111-1111-4111-8111-111111111111',
      title: '  Klinik hazırlığı  ',
      startsAt: '2026-07-26T09:00:00+03:00',
      endsAt: '2026-07-26T10:00:00+03:00',
      timezone: 'Europe/Istanbul',
    })).toMatchObject({
      title: 'Klinik hazırlığı',
      startsAt: '2026-07-26T06:00:00.000Z',
      endsAt: '2026-07-26T07:00:00.000Z',
    });
  });

  it('rejects invalid intervals and unknown timezones', () => {
    const base = {
      clientActionId: 'create-1',
      assignedUserId: '11111111-1111-4111-8111-111111111111',
      title: 'Plan',
      startsAt: '2026-07-26T09:00:00.000Z',
      endsAt: '2026-07-26T09:00:00.000Z',
      timezone: 'Europe/Istanbul',
    };
    expect(() => parseManualEventCreate(base)).toThrow(/Bitiş zamanı/);
    expect(() => parseManualEventCreate({
      ...base,
      endsAt: '2026-07-26T10:00:00.000Z',
      timezone: 'Mars/Olympus',
    })).toThrow();
  });

  it('bounds list windows and requires a real patch field', () => {
    expect(() => parseCalendarQuery({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
    })).toThrow(/93 günü/);
    expect(() => parseManualEventPatch({
      clientActionId: 'patch-1',
      expectedVersion: 1,
    })).toThrow();
  });
});
