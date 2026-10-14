import { describe, expect, it } from 'vitest';

import { jobTypeLabel, jobTypeLabels } from '../src/jobs/job-labels';

describe('jobTypeLabel SSOT (overview/report labels)', () => {
  it('maps every known JobCard type to its canonical Turkish label', () => {
    expect(jobTypeLabels).toEqual({
      PRODUCT_DELIVERY: 'Ürün teslimi',
      GENERAL_TASK: 'Genel görev',
      SALES_MEETING: 'Satış görüşmesi',
      WEEKLY_REPORT: 'Haftalık rapor',
      SALE: 'Satış kaydı',
    });
  });

  it('resolves WEEKLY_REPORT without leaking the raw enum', () => {
    expect(jobTypeLabel('WEEKLY_REPORT')).toBe('Haftalık rapor');
  });

  it('degrades an unknown future type code to a neutral label', () => {
    expect(jobTypeLabel('UNKNOWN_FUTURE_TYPE')).toBe('Diğer');
  });
});
