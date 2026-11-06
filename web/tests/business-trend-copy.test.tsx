/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { BusinessTrendView } from '../src/reports/BusinessTrend';
import type { BusinessTrendReportResponse } from '../src/reports/report-types';

const report: BusinessTrendReportResponse = {
  range: { from: '2026-11-01', to: '2026-11-06', timezone: 'Europe/Istanbul' },
  asOf: '2026-11-06T10:00:00.000Z',
  observedThrough: '2026-11-06',
  partialDay: true,
  totals: { visits: 2, followUps: 1, sales: 1 },
  points: [{ date: '2026-11-06', visits: 2, followUps: 1, sales: 1 }],
  comparison: null,
  relationships: { visitsWithFollowUp: 1, visitsWithSale: 1, followUpsWithSale: 1 },
};

describe('Production report copy', () => {
  it('keeps the timezone for date calculations but does not expose its technical identifier', () => {
    const html = renderToStaticMarkup(<MemoryRouter><BusinessTrendView report={report} /></MemoryRouter>);
    expect(html).toContain('Günlük ziyaret, takip ve satış sayıları');
    expect(html).not.toContain('Europe/Istanbul');
    expect(html).not.toContain('meeting_at');
    expect(html).toContain('Takip ziyaretleri, toplam ziyaretlerin içindedir.');
  });
});
