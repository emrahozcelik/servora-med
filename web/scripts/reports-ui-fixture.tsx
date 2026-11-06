import { createRoot } from 'react-dom/client';
import { useRef } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { BusinessTrend, BusinessTrendView } from '../src/reports/BusinessTrend';
import type { BusinessTrendReportResponse } from '../src/reports/report-types';
import { ReportsDashboardView } from '../src/reports/ReportsDashboard';
import { ReportShell, ReportDateRangeForm } from '../src/reports/report-shell';
import { ServoraAntProvider, StaffPerformanceTable } from '../src/ui/antd';
import '../src/styles.css';

const range = { from: '2026-10-01', to: '2026-10-28', timezone: 'Europe/Istanbul' };
const visits = [4, 6, 3, 0, 2, 5, 6, 4, 7, 5, 1, 0, 7, 8, 5, 8, 6, 0, 2, 9, 8, 7, 10, 8, 2, 0, 8, 11];
const points = visits.map((value, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`,
  visits: value, followUps: Math.floor(value / 2), sales: Math.floor(value / 3) }));
export const business: BusinessTrendReportResponse = {
  range, asOf: '2026-11-04T10:00:00.000Z', observedThrough: range.to, partialDay: false,
  totals: { visits: points.reduce((s, p) => s + p.visits, 0), followUps: points.reduce((s, p) => s + p.followUps, 0), sales: points.reduce((s, p) => s + p.sales, 0) },
  points, comparison: { range: { from: '2026-09-03', to: '2026-09-30', timezone: range.timezone }, totals: { visits: 115, followUps: 42, sales: 23 } },
  relationships: { visitsWithFollowUp: 51, visitsWithSale: 32, followUpsWithSale: 19 },
};
const dashboard = { range,
  counters: { activeJobCards: 24, overdueJobCards: 3, waitingApproval: 5, revisionRequested: 2, completedInPeriod: 201, cancelledInPeriod: 2 },
  completedTrend: points.map((p) => ({ date: p.date, count: p.visits + p.sales })),
  dailyCreatedTrend: points.map((p) => ({ date: p.date, count: p.visits + 2 })),
  activeStatusDistribution: [{ status: 'NEW' as const, count: 4 }, { status: 'ACCEPTED' as const, count: 5 }, { status: 'IN_PROGRESS' as const, count: 8 }, { status: 'WAITING_APPROVAL' as const, count: 5 }, { status: 'REVISION_REQUESTED' as const, count: 2 }],
  createdWorkTypeDistribution: [{ type: 'SALES_MEETING' as const, count: 150 }, { type: 'PRODUCT_DELIVERY' as const, count: 24 }, { type: 'GENERAL_TASK' as const, count: 18 }, { type: 'SALE' as const, count: 32 }],
};
const records = ['Ayşe Demir', 'Mehmet Yılmaz', 'Zeynep Çok Uzun Personel Soyadı'].map((name, i) => ({
  key: `staff-${i}`, name, isActive: i !== 2, completedJobs: 48 - i * 13, authoredOperationalNotes: 31,
  staffSubmissionAttribution: { recordedSubmissionCount: 50 - i * 9, recordedSubmissionDays: 17 },
  priorRangeLabel: '3 Eylül – 30 Eylül 2026', priorPerformance: { available: i !== 2, performance: i === 2 ? null : { completedJobs: 34 - i * 6, authoredOperationalNotes: 28 } },
  completionWorkTypes: [{ label: 'Ziyaret', count: 28 }, { label: 'Ürün teslimi', count: 12 }],
  currentWorkloadByType: [{ label: 'Ziyaret', count: 7 }, { label: 'Ürün teslimi', count: 3 }],
  currentWorkload: { openJobCards: 8 - i, overdueJobCards: i, waitingApproval: 3 - i, revisionRequested: 1 },
  reportHref: `/staff/staff-${i}/reports`,
}));

function Fixture() {
  const params = new URLSearchParams(location.search);
  const staff = params.has('staff');
  const scenario = params.get('case');
  let shown = business;
  if (scenario === 'zero' || scenario === 'future') shown = { ...business,
    totals: { visits: 0, followUps: 0, sales: 0 },
    relationships: { visitsWithFollowUp: 0, visitsWithSale: 0, followUpsWithSale: 0 },
    points: scenario === 'future' ? [] : points.map((p) => ({ ...p, visits: 0, followUps: 0, sales: 0 })),
    comparison: null, observedThrough: scenario === 'future' ? null : range.to,
  };
  if (scenario === 'long') shown = { ...business, range: { ...range, from: '2024-01-01', to: '2024-12-31' }, observedThrough: '2024-12-31',
    points: Array.from({ length: 366 }, (_, i) => ({ ...points[i % points.length], date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10) })),
  };
  const errorRef = useRef<HTMLDivElement>(null);
  return <MemoryRouter><ServoraAntProvider>
    <div className={`authenticated-shell authenticated-shell--${innerWidth >= 1024 ? 'desktop' : 'mobile'}`}>
      <aside className="shell-sidebar" style={{ display: innerWidth >= 1024 ? undefined : 'none' }}><div className="brand-lockup"><a className="dunya-dental-brand dunya-dental-brand--full" href="/" aria-label="Dünya Dental"><img alt="" src="/branding/dunya-dental-sidebar.png" /></a></div>
        <nav className="shell-nav" aria-label="Ana navigasyon"><a href="/jobs">İşler</a><a href="/customers">Müşteriler</a><a href="/products">Ürünler</a><a href="/" aria-current="page">Raporlar</a><a href="/staff">Personel</a></nav></aside>
      {innerWidth < 1024 && <header className="compact-shell-header mobile-top-bar"><div className="mobile-top-bar-start"><p className="mobile-shell-title">Raporlar</p></div><div className="mobile-top-bar-actions"><button type="button" className="shell-menu-button">Menü</button></div></header>}
      <div className="shell-content"><ReportShell title="Raporlar" current={staff ? 'staff' : 'summary'} range={range} description="Örnek veriler · Tasarım doğrulaması">
        <ReportDateRangeForm formKey="fixture" from={range.from} to={range.to} filterError="" errorRef={errorRef} onSubmit={(e) => e.preventDefault()} />
        {staff ? <><h2>Ekip görünümü</h2><p>Seçilen dönemde tamamlanan işler ve ekibin mevcut iş yükü.</p><StaffPerformanceTable records={records} /></> : <ReportsDashboardView report={dashboard} businessTrend={scenario === 'remote' ? <BusinessTrend range={range} /> : <BusinessTrendView report={shown} />} />}
      </ReportShell></div>
    </div>
  </ServoraAntProvider></MemoryRouter>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
