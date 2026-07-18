import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ReportsDashboardView } from '../src/reports/ReportsDashboard';
import type {
  ApprovalReportResponse,
  DashboardReportResponse,
} from '../src/reports/report-types';

const report: DashboardReportResponse = {
  range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
  counters: {
    activeJobCards: 8,
    overdueJobCards: 2,
    waitingApproval: 3,
    revisionRequested: 1,
    completedInPeriod: 5,
    cancelledInPeriod: 1,
  },
  completedTrend: [
    { date: '2026-07-01', count: 2 },
    { date: '2026-07-02', count: 0 },
  ],
};

const approval: ApprovalReportResponse = {
  summary: {
    pendingCount: 3,
    oldestWaitingMinutes: 1500,
    averageWaitingMinutes: 400,
    under2Hours: 1,
    between2And8Hours: 1,
    between8And24Hours: 0,
    over24Hours: 1,
  },
  items: [],
  total: 3,
  limit: 1,
  offset: 0,
};

function render(view: ReactElement) {
  return renderToStaticMarkup(<MemoryRouter>{view}</MemoryRouter>);
}

describe('Reports dashboard presentation', () => {
  it('shows overview KPIs before attention KPIs without design-meta copy', () => {
    const html = render(<ReportsDashboardView report={report} approval={approval} />);
    const overview = html.indexOf('Genel durum');
    const attention = html.indexOf('Öncelikli göstergeler');
    expect(overview).toBeGreaterThan(-1);
    expect(attention).toBeGreaterThan(overview);
    for (const label of ['Onay bekleyen', 'Geciken', 'Düzeltme bekleyen']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Aktif işler');
    expect(html).toContain('Bu dönemde tamamlanan');
    expect(html).toContain('Bu dönemde iptal edilen');
    expect(html).not.toContain('birbirini dışlayan dilimler');
    expect(html).not.toContain('pasta diyagramı');
  });

  it('pairs decorative TrendBars with visible summary and accessible calendar disclosure', () => {
    const html = render(<ReportsDashboardView report={report} approval={approval} />);
    expect(html).toContain('data-report-trend-section="true"');
    expect(html).toContain('data-report-trend-summary="true"');
    expect(html).toContain('Toplam 2 tamamlanma');
    expect(html).toContain('data-report-trend-bars="true"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('Tamamlanan işler');
    expect(html).toContain('report-calendar-table');
    expect(html).toContain('Temmuz 2026');
    expect(html).toContain('Pzt');
    expect(html).toContain('1 Tem 2026: 2 tamamlanan iş');
    expect(html).toContain('2 Tem 2026: 0 tamamlanan iş');
    // Independent meters remain label+value, not a 100% partition visual alone.
    expect(html).toContain('data-report-meters="true"');
    expect(html).toContain('Onay bekleyen');
  });

  it('states empty completion trend without relying on decorative bars', () => {
    const emptyTrend: DashboardReportResponse = {
      ...report,
      completedTrend: [],
      counters: { ...report.counters, completedInPeriod: 0 },
    };
    const html = render(<ReportsDashboardView report={emptyTrend} approval={approval} />);
    expect(html).toContain('Seçilen dönemde tamamlanma yok.');
    expect(html).not.toContain('data-report-trend-bars="true"');
    expect(html).toContain('Takvimde gösterilecek gün yok.');
  });

  it('shows mutually exclusive approval SLA buckets and attention actions', () => {
    const html = render(<ReportsDashboardView report={report} approval={approval} />);
    for (const label of ['2 saatten kısa', '2–8 saat', '8–24 saat', '24 saatten uzun']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Onay kuyruğunu aç');
    expect(html).toContain('Geciken işleri aç');
    expect(html).toContain('Düzeltme bekleyenleri aç');
    expect(html).toContain('süredir bekliyor');
    expect(html).toContain('/reports/approvals');
    expect(html).toContain('status=REVISION_REQUESTED');
    expect(html).toContain('dueBefore=');
  });
});
