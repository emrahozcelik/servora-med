import { describe, expect, it } from 'vitest';

import {
  canonicalScheduledDurationMs,
  canonicalScheduledEnd,
} from '../src/modules/job-cards/job-card-duration.js';

describe('JobCard canonical durations', () => {
  it('returns the frozen interval durations and elapsed-time end', () => {
    expect(canonicalScheduledDurationMs('SALES_MEETING')).toBe(60 * 60_000);
    expect(canonicalScheduledDurationMs('PRODUCT_DELIVERY')).toBe(30 * 60_000);
    expect(canonicalScheduledDurationMs('GENERAL_TASK')).toBeNull();
    expect(canonicalScheduledEnd('SALES_MEETING', '2026-03-29T00:30:00.000Z'))
      .toBe('2026-03-29T01:30:00.000Z');
    expect(canonicalScheduledEnd('PRODUCT_DELIVERY', '2026-03-29T00:30:00.000Z'))
      .toBe('2026-03-29T01:00:00.000Z');
    expect(canonicalScheduledEnd('GENERAL_TASK', '2026-03-29T00:30:00.000Z')).toBeNull();
  });

  it('adds duration to the instant across a DST transition', () => {
    expect(canonicalScheduledEnd('SALES_MEETING', '2026-03-29T00:30:00.000Z'))
      .toBe('2026-03-29T01:30:00.000Z');
  });
});
