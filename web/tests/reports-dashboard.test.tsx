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
  it('uses primary/secondary KPI hierarchy without claiming exclusive status slices', () => {
    const html = render(<ReportsDashboardView report={report} approval={approval} />);
    for (const label of ['Onay bekleyen', 'Geciken', 'Düzeltme bekleyen']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Aktif işler');
    expect(html).toContain('Bu dönemde tamamlanan');
    expect(html).toContain('Bu dönemde iptal edilen');
    expect(html).toContain('birbirini dışlayan dilimler değildir');
    expect(html).toContain('bağımsız çubuklar');
  });

  it('renders trend as the main visual with an accessible calendar disclosure', () => {
    const html = render(<ReportsDashboardView report={report} approval={approval} />);
    expect(html).toContain('report-trend-bars');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('Tamamlanan işler');
    expect(html).toContain('report-calendar-table');
    expect(html).toContain('Temmuz 2026');
    expect(html).toContain('Pzt');
    expect(html).toContain('1 Tem 2026: 2 tamamlanan iş');
    expect(html).toContain('2 Tem 2026: 0 tamamlanan iş');
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
