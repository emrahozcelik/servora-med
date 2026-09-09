import { describe, expect, it } from 'vitest';

import {
  hasValidPlannedIntervalForStart,
  isPlannedIntervalJobType,
  plannedIntervalShape,
} from '../src/jobs/job-schedule-integrity';

describe('isPlannedIntervalJobType', () => {
  it('treats SALES_MEETING and PRODUCT_DELIVERY as planned interval types', () => {
    expect(isPlannedIntervalJobType('SALES_MEETING')).toBe(true);
    expect(isPlannedIntervalJobType('PRODUCT_DELIVERY')).toBe(true);
  });

  it('excludes GENERAL_TASK', () => {
    expect(isPlannedIntervalJobType('GENERAL_TASK')).toBe(false);
  });
});

describe('hasValidPlannedIntervalForStart (R3 advisory mirror)', () => {
  it('accepts canonical SM interval', () => {
    expect(hasValidPlannedIntervalForStart({
      type: 'SALES_MEETING',
      scheduledAt: '2026-09-09T09:00:00.000Z',
      scheduledEndsAt: '2026-09-09T10:00:00.000Z',
    })).toBe(true);
  });

  it('accepts valid noncanonical SM 45m interval', () => {
    expect(hasValidPlannedIntervalForStart({
      type: 'SALES_MEETING',
      scheduledAt: '2026-09-09T09:00:00.000Z',
      scheduledEndsAt: '2026-09-09T09:45:00.000Z',
    })).toBe(true);
  });

  it('accepts canonical PD interval', () => {
    expect(hasValidPlannedIntervalForStart({
      type: 'PRODUCT_DELIVERY',
      scheduledAt: '2026-09-09T10:00:00.000Z',
      scheduledEndsAt: '2026-09-09T10:30:00.000Z',
    })).toBe(true);
  });

  it('accepts valid noncanonical PD 50m interval', () => {
    expect(hasValidPlannedIntervalForStart({
      type: 'PRODUCT_DELIVERY',
      scheduledAt: '2026-09-09T10:00:00.000Z',
      scheduledEndsAt: '2026-09-09T10:50:00.000Z',
    })).toBe(true);
  });

  it('rejects SM missing end', () => {
    expect(hasValidPlannedIntervalForStart({
      type: 'SALES_MEETING',
      scheduledAt: '2026-09-09T09:00:00.000Z',
      scheduledEndsAt: null,
    })).toBe(false);
  });

  it('rejects PD missing both', () => {
    expect(hasValidPlannedIntervalForStart({
      type: 'PRODUCT_DELIVERY',
      scheduledAt: null,
      scheduledEndsAt: null,
    })).toBe(false);
  });

  it('rejects zero-length interval', () => {
    expect(hasValidPlannedIntervalForStart({
      type: 'SALES_MEETING',
      scheduledAt: '2026-09-09T09:00:00.000Z',
      scheduledEndsAt: '2026-09-09T09:00:00.000Z',
    })).toBe(false);
  });

  it('rejects negative interval', () => {
    expect(hasValidPlannedIntervalForStart({
      type: 'SALES_MEETING',
      scheduledAt: '2026-09-09T09:00:00.000Z',
      scheduledEndsAt: '2026-09-09T08:30:00.000Z',
    })).toBe(false);
  });

  it('rejects non-finite timestamps', () => {
    expect(hasValidPlannedIntervalForStart({
      type: 'SALES_MEETING',
      scheduledAt: 'not-a-timestamp',
      scheduledEndsAt: '2026-09-09T09:45:00.000Z',
    })).toBe(false);
    expect(hasValidPlannedIntervalForStart({
      type: 'PRODUCT_DELIVERY',
      scheduledAt: '2026-09-09T10:00:00.000Z',
      scheduledEndsAt: 'also-not-a-timestamp',
    })).toBe(false);
  });

  it('treats undefined optional fields like null', () => {
    expect(hasValidPlannedIntervalForStart({
      type: 'SALES_MEETING',
      scheduledAt: '2026-09-09T09:00:00.000Z',
    })).toBe(false);
    expect(hasValidPlannedIntervalForStart({ type: 'SALES_MEETING' })).toBe(false);
  });

  it('exempts GENERAL_TASK null/null as open-ended', () => {
    expect(hasValidPlannedIntervalForStart({
      type: 'GENERAL_TASK',
      scheduledAt: null,
      scheduledEndsAt: null,
    })).toBe(true);
  });

  it('exempts GENERAL_TASK start-only as open-ended', () => {
    expect(hasValidPlannedIntervalForStart({
      type: 'GENERAL_TASK',
      scheduledAt: '2026-09-09T09:00:00.000Z',
      scheduledEndsAt: null,
    })).toBe(true);
  });
});

describe('plannedIntervalShape (advisory display signal)', () => {
  it('reports VALID for any-duration SM/PD interval', () => {
    expect(plannedIntervalShape({
      type: 'PRODUCT_DELIVERY',
      scheduledAt: '2026-09-09T10:00:00.000Z',
      scheduledEndsAt: '2026-09-09T10:50:00.000Z',
    })).toBe('VALID');
  });

  it('reports MISSING for both-null SM', () => {
    expect(plannedIntervalShape({
      type: 'SALES_MEETING',
      scheduledAt: null,
      scheduledEndsAt: null,
    })).toBe('MISSING');
  });

  it('reports INCOMPLETE for start without end', () => {
    expect(plannedIntervalShape({
      type: 'SALES_MEETING',
      scheduledAt: '2026-09-09T09:00:00.000Z',
      scheduledEndsAt: null,
    })).toBe('INCOMPLETE');
  });

  it('reports NOT_APPLICABLE for GT regardless of bounds', () => {
    expect(plannedIntervalShape({
      type: 'GENERAL_TASK',
      scheduledAt: null,
      scheduledEndsAt: null,
    })).toBe('NOT_APPLICABLE');
    expect(plannedIntervalShape({
      type: 'GENERAL_TASK',
      scheduledAt: '2026-09-09T09:00:00.000Z',
      scheduledEndsAt: null,
    })).toBe('NOT_APPLICABLE');
  });
});
