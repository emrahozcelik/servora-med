import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ReportsDashboardView } from '../src/reports/ReportsDashboard';
import type { DashboardReportResponse } from '../src/reports/report-types';

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
  dailyCreatedTrend: [
    { date: '2026-07-01', count: 3 },
    { date: '2026-07-02', count: 1 },
  ],
  activeStatusDistribution: [
    { status: 'NEW', count: 2 },
    { status: 'ACCEPTED', count: 1 },
    { status: 'IN_PROGRESS', count: 3 },
    { status: 'WAITING_APPROVAL', count: 1 },
    { status: 'REVISION_REQUESTED', count: 1 },
  ],
  createdWorkTypeDistribution: [
    { type: 'PRODUCT_DELIVERY', count: 2 },
    { type: 'GENERAL_TASK', count: 1 },
    { type: 'SALES_MEETING', count: 2 },
  ],
};

function render(view: ReactElement) {
  return renderToStaticMarkup(<MemoryRouter>{view}</MemoryRouter>);
}

describe('Reports dashboard presentation', () => {
  it('presents five executive KPIs with explicit snapshot and period scope', () => {
    const html = render(<ReportsDashboardView report={report} />);
    const kpis = html.match(/data-report-kpi="true"/g) ?? [];

    expect(kpis).toHaveLength(5);
    expect(html).toContain('Aktif İşler');
    expect(html).toContain('Dönemde Tamamlanan');
    expect(html).toContain('Geciken İşler');
    expect(html).toContain('Onay Bekleyen');
    expect(html).toContain('Düzeltme Bekleyen');
    expect(html).toContain('Mevcut durum');
    expect(html).toContain('Seçilen dönem');
  });

  it('renders the executive sections in semantic order without the retired SLA panel', () => {
    const html = render(<ReportsDashboardView report={report} />);
    const headings = [
      'Genel Durum',
      'İş Akışı Eğilimi',
      'Mevcut İş Akışı',
      'İş Türleri',
      'Dikkat Gerektirenler',
    ];
    const positions = headings.map((heading) => html.indexOf(heading));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).not.toContain('Onay bekleme dağılımı');
    expect(html).not.toContain('Tamamlanma oranı');
    expect(html).not.toContain('completion rate');
  });

  it('renders current lifecycle and created work-type distributions in canonical order', () => {
    const zeroBuckets: DashboardReportResponse = {
      ...report,
      activeStatusDistribution: report.activeStatusDistribution.map((item) => (
        item.status === 'REVISION_REQUESTED' ? { ...item, count: 0 } : item
      )),
      createdWorkTypeDistribution: report.createdWorkTypeDistribution.map((item) => (
        item.type === 'SALES_MEETING' ? { ...item, count: 0 } : item
      )),
    };
    const html = render(<ReportsDashboardView report={zeroBuckets} />);

    expect(html).toContain('data-report-distribution="active-status"');
    expect(html).toContain('data-report-distribution="created-work-type"');
    for (const label of ['Hazırlanıyor', 'Atandı', 'Uygulanıyor', 'Yönetici kontrolünde', 'Düzeltme istendi']) {
      expect(html).toContain(label);
    }
    for (const label of ['Ürün teslimi', 'Genel görev', 'Satış görüşmesi']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('<strong>0</strong>');
    expect(html.indexOf('Hazırlanıyor')).toBeLessThan(html.indexOf('Atandı'));
    expect(html.indexOf('Atandı')).toBeLessThan(html.indexOf('Uygulanıyor'));
    expect(html.indexOf('Uygulanıyor')).toBeLessThan(html.indexOf('Yönetici kontrolünde'));
    expect(html.indexOf('Yönetici kontrolünde')).toBeLessThan(html.indexOf('Düzeltme istendi'));
  });

  it('renders independent created and completed workflow cohorts with accessible daily data', () => {
    const html = render(<ReportsDashboardView report={report} />);

    expect(html).toContain('data-report-workflow-trend="true"');
    expect(html).toContain('Oluşturulan <strong>4</strong>');
    expect(html).toContain('Tamamlanan <strong>2</strong>');
    expect(html).toContain('Seçilen dönemde oluşturulan ve tamamlanan işlerin günlük sayısı.');
    expect(html).toContain('report-workflow-table');
    expect(html).toContain('Günlük iş akışı verileri');
    expect(html).toContain('data-date="2026-07-01"');
    expect(html).toContain('<th scope="col">Oluşturulan</th>');
    expect(html).toContain('<th scope="col">Tamamlanan</th>');
    expect(html).toContain('aria-hidden="true"');
  });

  it('states an empty workflow truthfully without hiding zero KPI values', () => {
    const emptyReport: DashboardReportResponse = {
      ...report,
      counters: { ...report.counters, completedInPeriod: 0 },
      completedTrend: [],
      dailyCreatedTrend: [],
    };
    const html = render(<ReportsDashboardView report={emptyReport} />);

    expect(html).toContain('Dönemde Tamamlanan');
    expect(html).toContain('data-report-workflow-trend="true"');
    expect(html).toContain('Oluşturulan <strong>0</strong>');
    expect(html).toContain('Tamamlanan <strong>0</strong>');
    expect(html).toContain('Seçilen dönemde günlük hareket bulunmuyor.');
    expect(html).not.toContain('data-report-trend-bars="true"');
  });

  it('keeps all attention cards actionable and truthful at zero', () => {
    const html = render(<ReportsDashboardView report={report} />);

    expect((html.match(/data-attention-key=/g) ?? [])).toHaveLength(3);
    expect(html).toContain('Geciken işleri aç');
    expect(html).toContain('Onay kuyruğunu aç');
    expect(html).toContain('Düzeltme bekleyenleri aç');
    expect(html).toContain('/reports/approvals');
    expect(html).toContain('status=REVISION_REQUESTED');
    expect(html).toContain('overdue=true');

    const zeroReport: DashboardReportResponse = {
      ...report,
      counters: {
        ...report.counters,
        overdueJobCards: 0,
        waitingApproval: 0,
        revisionRequested: 0,
      },
    };
    const zeroHtml = render(<ReportsDashboardView report={zeroReport} />);
    expect(zeroHtml).toContain('0 iş gecikmiş');
    expect(zeroHtml).toContain('0 iş onay bekliyor');
    expect(zeroHtml).toContain('0 iş düzeltme bekliyor');
    expect((zeroHtml.match(/data-attention-key=/g) ?? [])).toHaveLength(3);
  });
});
