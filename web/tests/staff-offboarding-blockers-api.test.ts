import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/services/api';
import {
  listStaffOffboardingWeeklyReportBlockers,
  weeklyReportOffboardingBlockerFromError,
} from '../src/services/people-api';

const target = '550e8400-e29b-41d4-a716-446655440001';
const jobCardId = '550e8400-e29b-41d4-a716-446655440002';
const reportId = '550e8400-e29b-41d4-a716-446655440003';
const item = {
  jobCardId, reportId, staffUserId: target, assignedTo: target,
  periodStart: '2026-08-03', status: 'WAITING_APPROVAL', jobVersion: 3,
  reportVersion: 2, reason: 'UNFINISHED',
};
const page = { total: 1, limit: 50, hasMore: false, items: [item] };
const blocker = (value: unknown) => new ApiError(409, 'OFFBOARDING_WEEKLY_REPORT_REQUIRES_RESOLUTION',
  'Raporlar sonuçlandırılmalı.', false, { weeklyReports: value });

afterEach(() => vi.unstubAllGlobals());

describe('SOF-2C WeeklyReport blocker contract', () => {
  it('accepts only the bounded metadata for the requested Staff and leaves the 409 shape unchanged', () => {
    expect(weeklyReportOffboardingBlockerFromError(blocker(page), target)).toEqual(page);
    expect(weeklyReportOffboardingBlockerFromError(new ApiError(409, 'STALE_PLAN', 'Eski plan'), target)).toBeNull();
  });

  it('rejects sensitive, malformed, wrong-target and inconsistent historical metadata', () => {
    for (const invalid of [
      { ...page, items: [{ ...item, draft: 'gizli içerik' }] },
      { ...page, hasMore: true },
      { ...page, total: 0 },
      { ...page, items: [{ ...item, assignedTo: reportId, staffUserId: reportId }] },
      { ...page, items: [{ ...item, reason: 'MISSING_REPORT' }] },
      { ...page, items: [{ ...item, reason: 'OWNER_ASSIGNEE_MISMATCH' }] },
      { ...page, items: [{ ...item, periodStart: '2026-02-30' }] },
    ]) {
      expect(() => weeklyReportOffboardingBlockerFromError(blocker(invalid), target)).toThrowError(ApiError);
    }
    expect(weeklyReportOffboardingBlockerFromError(blocker({ ...page, items: [{ ...item,
      reportId: null, staffUserId: null, periodStart: null, reportVersion: null, reason: 'MISSING_REPORT',
    }] }), target)?.items[0]?.reason).toBe('MISSING_REPORT');
  });

  it('sends a bounded keyset request and validates the read-only page', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(page),
      { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', fetcher);
    const result = await listStaffOffboardingWeeklyReportBlockers(target, item);
    expect(result.total).toBe(1);
    const [url, options] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/users/${target}/offboarding/weekly-report-blockers?`);
    expect(new URL(url, 'http://localhost').searchParams.get('afterJobCardId')).toBe(jobCardId);
    expect(new URL(url, 'http://localhost').searchParams.get('afterPeriodStart')).toBe('2026-08-03');
    expect(options.credentials).toBe('include');
    expect(options.method).toBeUndefined();
    await listStaffOffboardingWeeklyReportBlockers(target, { ...item, periodStart: null });
    expect(new URL(fetcher.mock.calls[1]![0] as string, 'http://localhost')
      .searchParams.get('afterPeriodStart')).toBe('null');
  });
});
