/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { shiftInterval } from '../src/jobs/scheduling';

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