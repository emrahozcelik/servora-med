import { describe, expect, it } from 'vitest';

import { reportSectionHref } from '../src/reports/report-navigation';

describe('reportSectionHref', () => {
  it('preserves from/to between summary and deliveries only', () => {
    const range = { from: '2026-07-01', to: '2026-07-07' };
    expect(reportSectionHref('summary', range)).toBe('/reports?from=2026-07-01&to=2026-07-07');
    expect(reportSectionHref('deliveries', range)).toBe(
      '/reports/deliveries?from=2026-07-01&to=2026-07-07',
    );
    expect(reportSectionHref('approvals', range)).toBe('/reports/approvals');
  });

  it('omits incomplete ranges and does not invent delivery filters', () => {
    expect(reportSectionHref('deliveries', { from: '2026-07-01', to: null }))
      .toBe('/reports/deliveries');
    expect(reportSectionHref('summary', null)).toBe('/reports');
  });
});
