/**
 * Pure value-contract tests for the mobile wheel picker.
 * Device-local strings only; no UTC instant conversion happens here.
 */
process.env.TZ = 'Europe/Istanbul';

import { beforeAll, describe, expect, it } from 'vitest';

import type {
  WheelColumnModel,
  WheelContext,
  WheelSelection,
} from '../src/ui/wheel-datetime';

type WheelModule = typeof import('../src/ui/wheel-datetime');
let wheel: WheelModule;

beforeAll(async () => {
  wheel = await import('../src/ui/wheel-datetime');
});

/** Wednesday 25 November 2026, 09:00 Europe/Istanbul. */
const NOW = new Date(2026, 10, 25, 9, 0, 0);

function column(columns: WheelColumnModel[], key: WheelColumnModel['key']): WheelColumnModel {
  const found = columns.find((entry) => entry.key === key);
  if (!found) throw new Error(`Missing ${key} column`);
  return found;
}

describe('parse and format', () => {
  it('parses and formats the datetime-local contract exactly', () => {
    const parsed = wheel.parseWheelValue('datetime', '2026-11-26T10:30');
    expect(parsed).toEqual({ date: '2026-11-26', hour: 10, minute: 30 });
    expect(wheel.formatWheelValue('datetime', parsed!)).toBe('2026-11-26T10:30');
    expect(wheel.parseWheelValue('datetime', '2026-11-26T10:30:45')).toEqual(parsed);
  });

  it('parses date and time modes without inventing components', () => {
    expect(wheel.parseWheelValue('date', '2026-11-26'))
      .toEqual({ date: '2026-11-26', hour: 0, minute: 0 });
    expect(wheel.parseWheelValue('time', '10:30'))
      .toEqual({ date: '', hour: 10, minute: 30 });
    expect(wheel.formatWheelValue('time', { date: '', hour: 9, minute: 5 })).toBe('09:05');
  });

  it('rejects empty, malformed and impossible values', () => {
    expect(wheel.parseWheelValue('datetime', '')).toBeNull();
    expect(wheel.parseWheelValue('datetime', '2026-11-26 10:30')).toBeNull();
    expect(wheel.parseWheelValue('datetime', '2026-02-30T10:00')).toBeNull();
    expect(wheel.parseWheelValue('datetime', '2026-11-26T24:00')).toBeNull();
    expect(wheel.parseWheelValue('date', '2026-13-01')).toBeNull();
    expect(wheel.parseWheelValue('time', '10:60')).toBeNull();
    expect(wheel.parseWheelValue('time', '9:30')).toBeNull();
  });

  it('formats the closed field with a Turkish weekday in Europe/Istanbul', () => {
    expect(wheel.formatWheelDisplay('datetime', '2026-11-26T10:30'))
      .toBe('Per 26 Kas · 10:30');
    expect(wheel.formatWheelDisplay('date', '2026-11-26')).toBe('Per 26 Kas 2026');
    expect(wheel.formatWheelDisplay('time', '10:30')).toBe('10:30');
    expect(wheel.formatWheelDisplay('datetime', '')).toBe('');
  });
});

describe('minute rounding', () => {
  it('rounds up to the next step and keeps exact boundaries', () => {
    expect(wheel.roundUpMinutes(600, 5)).toBe(600);
    expect(wheel.roundUpMinutes(601, 5)).toBe(605);
    expect(wheel.roundUpMinutes(602, 15)).toBe(615);
    expect(wheel.roundUpMinutes(0, 5)).toBe(0);
  });

  it('rounds seconds up and rolls over into the next day', () => {
    expect(wheel.nowWheelSelection('datetime', new Date(2026, 10, 25, 10, 2, 30), 5))
      .toEqual({ date: '2026-11-25', hour: 10, minute: 5 });
    expect(wheel.nowWheelSelection('datetime', new Date(2026, 10, 25, 23, 58, 30), 5))
      .toEqual({ date: '2026-11-26', hour: 0, minute: 0 });
    expect(wheel.nowWheelSelection('datetime', new Date(2026, 10, 25, 10, 0, 0), 5))
      .toEqual({ date: '2026-11-25', hour: 10, minute: 0 });
  });

  it('uses midnight for date mode and the clock only for time mode', () => {
    expect(wheel.nowWheelSelection('date', new Date(2026, 10, 25, 15, 42), 5))
      .toEqual({ date: '2026-11-25', hour: 0, minute: 0 });
    expect(wheel.nowWheelSelection('time', new Date(2026, 10, 25, 10, 2, 30), 15))
      .toEqual({ date: '', hour: 10, minute: 15 });
  });
});

describe('min/max clamping', () => {
  const context: WheelContext = {
    now: NOW,
    min: '2026-11-25T09:00',
    max: '2026-11-30T18:00',
    minuteStep: 5,
  };

  it('clamps a stored value into the allowed range', () => {
    expect(wheel.initialWheelSelection('datetime', '2026-11-20T08:00', context))
      .toEqual({ date: '2026-11-25', hour: 9, minute: 0 });
    expect(wheel.initialWheelSelection('datetime', '2026-12-05T08:00', context))
      .toEqual({ date: '2026-11-30', hour: 18, minute: 0 });
  });

  it('clamps the rounded "now" start into the allowed range', () => {
    expect(wheel.initialWheelSelection('datetime', '', {
      now: new Date(2026, 10, 25, 8, 0, 30),
      min: '2026-11-25T09:00',
      max: '2026-11-30T18:00',
      minuteStep: 5,
    })).toEqual({ date: '2026-11-25', hour: 9, minute: 0 });
  });

  it('starts an empty value at now rounded up to the step', () => {
    expect(wheel.initialWheelSelection('datetime', '', {
      now: new Date(2026, 10, 25, 10, 2, 30),
      minuteStep: 5,
    })).toEqual({ date: '2026-11-25', hour: 10, minute: 5 });
  });

  it('compares time-only bounds by clock time', () => {
    const bounds = wheel.parseWheelBounds('time', '09:00', '18:00');
    expect(wheel.isWithinWheelBounds({ date: '', hour: 8, minute: 59 }, bounds)).toBe(false);
    expect(wheel.isWithinWheelBounds({ date: '', hour: 9, minute: 0 }, bounds)).toBe(true);
    expect(wheel.isWithinWheelBounds({ date: '', hour: 18, minute: 1 }, bounds)).toBe(false);
  });
});

describe('Turkish day labels', () => {
  const selection: WheelSelection = { date: '2026-11-25', hour: 10, minute: 30 };

  it('labels today, tomorrow and the following weekday', () => {
    const days = column(wheel.buildWheelColumns('datetime', selection, {
      now: NOW,
      minuteStep: 5,
    }), 'day');
    expect(days.label).toBe('Gün');
    expect(days.value).toBe('2026-11-25');
    const labelOf = (date: string) => days.options.find((option) => option.value === date)?.label;
    expect(labelOf('2026-11-25')).toBe('Bugün');
    expect(labelOf('2026-11-26')).toBe('Yarın');
    expect(labelOf('2026-11-27')).toBe('Cuma 27 Kas');
    expect(labelOf('2026-11-28')).toBe('Cumartesi 28 Kas');
    expect(days.options[0]?.value).toBe('2026-10-26');
  });

  it('offers today-30 … today+365 by default', () => {
    const days = column(wheel.buildWheelColumns('datetime', selection, {
      now: NOW,
      minuteStep: 5,
    }), 'day');
    expect(days.options[0]?.value).toBe('2026-10-26');
    expect(days.options.at(-1)?.value).toBe('2027-11-25');
  });

  it('clips the day range to min/max', () => {
    const days = column(wheel.buildWheelColumns('datetime', selection, {
      now: NOW,
      min: '2026-11-24T09:00',
      max: '2026-11-27T18:00',
      minuteStep: 5,
    }), 'day');
    expect(days.options.map((option) => option.value))
      .toEqual(['2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']);
  });
});

describe('column options', () => {
  it('steps the minute wheel and keeps an off-step stored minute', () => {
    const onStep = column(wheel.buildWheelColumns('time', { date: '', hour: 10, minute: 30 }, {
      now: NOW,
      minuteStep: 15,
    }), 'minute');
    expect(onStep.options.map((option) => option.label)).toEqual(['00', '15', '30', '45']);

    const offStep = column(wheel.buildWheelColumns('time', { date: '', hour: 10, minute: 7 }, {
      now: NOW,
      minuteStep: 15,
    }), 'minute');
    expect(offStep.options.map((option) => option.value)).toEqual(['0', '7', '15', '30', '45']);
    expect(offStep.value).toBe('7');
  });

  it('disables hours and minutes outside min/max on boundary days', () => {
    const hours = column(wheel.buildWheelColumns('datetime', {
      date: '2026-11-25', hour: 9, minute: 0,
    }, {
      now: NOW,
      min: '2026-11-25T09:00',
      max: '2026-11-25T18:25',
      minuteStep: 5,
    }), 'hour');
    expect(hours.options[8]?.disabled).toBe(true);
    expect(hours.options[9]?.disabled).toBe(false);
    expect(hours.options[18]?.disabled).toBe(false);
    expect(hours.options[19]?.disabled).toBe(true);

    const minutes = column(wheel.buildWheelColumns('datetime', {
      date: '2026-11-25', hour: 18, minute: 0,
    }, {
      now: NOW,
      min: '2026-11-25T09:00',
      max: '2026-11-25T18:25',
      minuteStep: 5,
    }), 'minute');
    expect(minutes.options.filter((option) => !option.disabled).map((option) => option.value))
      .toEqual(['0', '5', '10', '15', '20', '25']);
    expect(minutes.options.find((option) => option.value === '30')?.disabled).toBe(true);
  });

  it('builds date mode as day / month / year', () => {
    const columns = wheel.buildWheelColumns('date', {
      date: '2026-11-26', hour: 0, minute: 0,
    }, { now: NOW });
    expect(columns.map((entry) => entry.key)).toEqual(['day', 'month', 'year']);
    const november = column(columns, 'month').options[10];
    expect(november?.value).toBe('11');
    expect(november?.label).toBe('Kasım');
    expect(column(columns, 'day').options).toHaveLength(30);
    expect(column(columns, 'year').value).toBe('2026');
    expect(column(columns, 'year').options.map((option) => option.value))
      .toEqual(['2025', '2026', '2027', '2028', '2029', '2030', '2031']);
  });

  it('disables date-mode days outside min/max', () => {
    const columns = wheel.buildWheelColumns('date', {
      date: '2026-11-26', hour: 0, minute: 0,
    }, { now: NOW, min: '2026-11-26', max: '2026-11-30' });
    const days = column(columns, 'day');
    expect(days.options[24]?.disabled).toBe(true);
    expect(days.options[25]?.disabled).toBe(false);
    expect(days.options.at(-1)?.value).toBe('30');
    expect(days.options.at(-1)?.disabled).toBe(false);
  });
});

describe('column application', () => {
  const context: WheelContext = { now: NOW, minuteStep: 5 };

  it('clamps a date-mode month change to the month length', () => {
    const january: WheelSelection = { date: '2026-01-31', hour: 0, minute: 0 };
    expect(wheel.applyWheelColumnChange('date', january, 'month', '2', context))
      .toEqual({ date: '2026-02-28', hour: 0, minute: 0 });
  });

  it('clamps a time-mode hour change against the end bound', () => {
    expect(wheel.applyWheelColumnChange(
      'time',
      { date: '', hour: 12, minute: 55 },
      'hour',
      '13',
      { now: NOW, minuteStep: 5, min: '09:00', max: '13:00' },
    )).toEqual({ date: '', hour: 13, minute: 0 });
  });

  it('snaps an invalid minute after a datetime hour change', () => {
    expect(wheel.applyWheelColumnChange(
      'datetime',
      { date: '2026-11-25', hour: 9, minute: 0 },
      'hour',
      '8',
      { now: NOW, minuteStep: 5, min: '2026-11-25T09:00' },
    )).toEqual({ date: '2026-11-25', hour: 9, minute: 0 });
  });

  it('keeps the stored minute when the new hour still allows it', () => {
    expect(wheel.applyWheelColumnChange(
      'datetime',
      { date: '2026-11-25', hour: 10, minute: 30 },
      'hour',
      '11',
      context,
    )).toEqual({ date: '2026-11-25', hour: 11, minute: 30 });
  });
});
