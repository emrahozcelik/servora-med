import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ReportsDashboardView } from '../src/reports/ReportsDashboard';
import type { DashboardReportResponse } from '../src/reports/report-types';

const report: DashboardReportResponse = {
  range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
  counters: { activeJobCards: 8, overdueJobCards: 2, waitingApproval: 3,
    revisionRequested: 1, completedInPeriod: 5, cancelledInPeriod: 1 },
  completedTrend: [
    { date: '2026-07-01', count: 2 },
    { date: '2026-07-02', count: 0 },
  ],
};

describe('Reports dashboard presentation', () => {
  it('distinguishes current-state and selected-period counters', () => {
    const html = renderToStaticMarkup(<ReportsDashboardView report={report} />);
    for (const label of ['Aktif işler', 'Geciken işler', 'Onay bekleyenler', 'Düzeltme bekleyenler']) {
      expect(html).toContain(label);
    }
    expect(html.match(/Şu an/g)).toHaveLength(4);
    expect(html).toContain('Seçilen dönemde tamamlandı');
    expect(html).toContain('Seçilen dönemde iptal edildi');
  });

  it('renders every trend day in an authoritative semantic table', () => {
    const html = renderToStaticMarkup(<ReportsDashboardView report={report} />);
    expect(html).toContain('Tamamlanan işlerin günlük dağılımı');
    expect(html).toContain('1 Tem 2026');
    expect(html).toContain('2 Tem 2026');
    expect(html).toMatch(/2 Tem 2026[\s\S]*>0</);
    expect(html).toContain('aria-hidden="true"');
  });
});
