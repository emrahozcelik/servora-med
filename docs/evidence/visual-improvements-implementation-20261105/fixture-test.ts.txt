import { describe, expect, it } from 'vitest';

import { customer, history, profile, report, weekly } from '../scripts/visual-improvements-fixture';
import { parseStaffReport } from '../src/reports/reports-api';

describe('Visual baseline fixture integrity', () => {
  it('uses the current report parser and reconciles counts with the history', () => {
    expect(parseStaffReport(report)).toEqual(report);
    expect(report.completedTrend.reduce((sum, point) => sum + point.count, 0)).toBe(report.performance.completedJobs);
    expect(report.completionWorkTypes.reduce((sum, point) => sum + point.count, 0)).toBe(report.performance.completedJobs);
    expect(report.currentWorkloadByType.reduce((sum, point) => sum + point.count, 0))
      .toBe(profile.counters.open + profile.counters.waitingApproval + profile.counters.revisionRequested);
    expect(history.filter(job => job.status === 'COMPLETED')).toHaveLength(customer.completedJobCount);
    expect(history.filter(job => job.status !== 'COMPLETED')).toHaveLength(customer.openJobCount);
    expect(history.every(job => job.customer?.id === customer.id)).toBe(true);
    expect(weekly[0].staffUserId).toBe(profile.user.id);
  });
});
