/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalReportView } from '../src/reports/ApprovalReport';
import { DeliveryReportView } from '../src/reports/DeliveryReport';
import {
  ReportsDashboard,
  ReportsDashboardView,
} from '../src/reports/ReportsDashboard';
import { StaffOperationalReport } from '../src/reports/StaffOperationalReport';
import { getDashboardReport } from '../src/reports/reports-api';
import type {
  ApprovalReportResponse,
  DashboardReportResponse,
  DeliveryReportResponse,
  StaffReportResponse,
} from '../src/reports/report-types';

vi.mock('../src/reports/reports-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/reports/reports-api')>(),
  getDashboardReport: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const dashboard: DashboardReportResponse = {
  range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
  counters: { activeJobCards: 8, overdueJobCards: 2, waitingApproval: 3,
    revisionRequested: 1, completedInPeriod: 5, cancelledInPeriod: 1 },
  completedTrend: [{ date: '2026-07-01', count: 2 }, { date: '2026-07-02', count: 0 }],
  dailyCreatedTrend: [{ date: '2026-07-01', count: 2 }, { date: '2026-07-02', count: 1 }],
  activeStatusDistribution: [
    { status: 'NEW', count: 1 },
    { status: 'ACCEPTED', count: 1 },
    { status: 'IN_PROGRESS', count: 1 },
    { status: 'WAITING_APPROVAL', count: 0 },
    { status: 'REVISION_REQUESTED', count: 0 },
  ],
  createdWorkTypeDistribution: [
    { type: 'PRODUCT_DELIVERY', count: 1 },
    { type: 'GENERAL_TASK', count: 1 },
    { type: 'SALES_MEETING', count: 0 },
  ],
};

function markup(element: ReactNode) {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(element);
  return container;
}

describe('Report accessibility contract', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(getDashboardReport).mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('exposes executive sections, visible values, and semantic workflow data', () => {
    const view = markup(
      <MemoryRouter>
        <ReportsDashboardView report={dashboard} />
      </MemoryRouter>,
    );

    expect(view.querySelectorAll('[data-report-kpi="true"]')).toHaveLength(5);
    expect(view.textContent).toContain('Aktif İşler');
    expect(view.textContent).toContain('Dönemde Tamamlanan');
    expect(view.textContent).toContain('Mevcut durum');
    expect(view.textContent).toContain('Seçilen dönem');

    const headings = [...view.querySelectorAll('.report-section h2')].map((heading) => heading.textContent);
    expect(headings).toEqual([
      'Genel Durum', 'İş Akışı Eğilimi', 'Mevcut İş Akışı', 'İş Türleri', 'Dikkat Gerektirenler',
    ]);

    const workflow = view.querySelector('[data-report-workflow-trend="true"]');
    expect(workflow?.querySelector('.report-workflow-plot')?.getAttribute('aria-hidden')).toBe('true');
    expect(workflow?.querySelectorAll('.report-workflow-table thead th[scope="col"]')).toHaveLength(3);
    expect(workflow?.querySelector('[data-date="2026-07-01"]')?.textContent).toContain('1 Tem 2026');
    expect(workflow?.textContent).toContain('Oluşturulan');
    expect(workflow?.textContent).toContain('Tamamlanan');

    expect(view.querySelector('[data-report-distribution="active-status"]')?.getAttribute('aria-label'))
      .toBe('Mevcut iş akışı durumları');
    expect(view.querySelector('[data-report-distribution="created-work-type"]')?.getAttribute('aria-label'))
      .toBe('Oluşturulan iş türleri');
    expect(view.textContent).toContain('Yönetici kontrolünde');
    expect(view.textContent).toContain('Ürün teslimi');
    expect(view.querySelectorAll('[data-attention-key]')).toHaveLength(3);
    expect(view.querySelector('a[href="/reports/approvals"]')?.textContent).toBe('Onay kuyruğunu aç');
  });

  it('gives delivery OperationalTable and Staff tables accessible dual/mobile contracts', () => {
    const delivery: DeliveryReportResponse = {
      groupBy: 'purpose',
      items: [{ purpose: 'SALE', unit: 'Kutu', quantity: '3.000' }],
      range: dashboard.range,
      total: 1,
      limit: 50,
      offset: 0,
    };
    const staff: StaffReportResponse = {
      staff: { userId: 'staff-1', name: 'Ayşe', isActive: false },
      range: dashboard.range,
      priorRange: { from: '2026-05-31', to: '2026-06-30',
        timezone: 'Europe/Istanbul' },
      performance: { completedJobs: 5, completionDays: 2, jobsPerCompletionDay: 2.5,
        correctionRequestEvents: 1, authoredOperationalNotes: 3 },
      priorPerformance: { available: true, performance: { completedJobs: 4,
        completionDays: 2, jobsPerCompletionDay: 2, correctionRequestEvents: 0,
        authoredOperationalNotes: 2 } },
      staffExecution: { staffCompletedJobs: 4,
        staffCompletionDays: 2, jobsPerStaffCompletionDay: 2,
        missingStaffCompletionTimestamp: 1 },
      onTime: { eligibleScheduledCompletedJobs: 3, onTimeCompletedJobs: 2,
        lateCompletedJobs: 1, ineligibleOrNoDeadlineCompletedJobs: 2, onTimeRate: 2 / 3 },
      staffSubmissionAttribution: { recordedSubmissionCount: 2, recordedSubmissionDays: 2 },
      completionWorkTypes: [
        { type: 'PRODUCT_DELIVERY', count: 0 },
        { type: 'GENERAL_TASK', count: 5 },
        { type: 'SALES_MEETING', count: 0 },
      ],
      currentWorkloadByType: [
        { type: 'PRODUCT_DELIVERY', count: 0 },
        { type: 'GENERAL_TASK', count: 1 },
        { type: 'SALES_MEETING', count: 0 },
      ],
      completedTrend: [{ date: '2026-07-01', count: 5 }],
      deliveriesByPurpose: delivery.items,
      meetingsByOutcome: [
        { outcome: 'POSITIVE', count: 0 }, { outcome: 'FOLLOW_UP_REQUIRED', count: 0 },
        { outcome: 'NO_DECISION', count: 0 }, { outcome: 'NOT_INTERESTED', count: 0 },
      ],
      currentWorkload: { openJobCards: 1, waitingApproval: 2, revisionRequested: 3,
        overdueJobCards: 4 },
    };

    const deliveryView = markup(<DeliveryReportView report={delivery} />);
    expect(deliveryView.querySelector('[data-servora-operational-table="true"]')).not.toBeNull();
    expect(deliveryView.querySelector('table caption')?.textContent).not.toBe('');
    expect(deliveryView.querySelectorAll('thead th[scope="col"]').length).toBeGreaterThan(0);
    expect(deliveryView.querySelector('tbody th[scope="row"]')).not.toBeNull();
    expect(deliveryView.querySelector('.servora-operational-table__mobile')).not.toBeNull();
    expect(deliveryView.querySelector('.servora-operational-table__mobile-caption')?.textContent)
      .toContain('birim kırılımları birleştirilmez');
    expect(deliveryView.querySelectorAll('.servora-operational-table__field dt').length)
      .toBeGreaterThan(0);

    const staffView = markup(<StaffOperationalReport report={staff} />);
    expect(staffView.querySelectorAll('[data-servora-operational-table="true"]')).toHaveLength(3);
    expect(staffView.querySelector('table caption')?.textContent).not.toBe('');
    expect(staffView.querySelectorAll('thead th[scope="col"]').length).toBeGreaterThan(0);
    expect(staffView.querySelector('tbody th[scope="row"]')).not.toBeNull();
    expect(staffView.querySelectorAll('.servora-operational-table__mobile')).toHaveLength(3);
    expect(staffView.querySelectorAll('.servora-operational-table__field dt').length)
      .toBeGreaterThan(0);
    expect(staffView.textContent).toContain('Pasif personel');
    expect(staffView.textContent).toContain('Aksiyon alınabilir');
    expect(staffView.textContent).toContain('Mevcut iş yükünün tür dağılımı');
    expect(staffView.textContent).not.toContain('Personelin bitirme zamanı');
  });

  it('keeps approval age buckets textual instead of relying on color', () => {
    const report: ApprovalReportResponse = {
      summary: { pendingCount: 4, oldestWaitingMinutes: 1500, averageWaitingMinutes: 400,
        under2Hours: 1, between2And8Hours: 1, between8And24Hours: 1, over24Hours: 1 },
      items: [], total: 4, limit: 50, offset: 0,
    };
    const text = markup(<ApprovalReportView report={report} />).textContent;
    for (const label of ['2 saatten kısa', '2–8 saat', '8–24 saat', '24 saatten uzun']) {
      expect(text).toContain(label);
    }
  });

  it('focuses a linked error summary and marks both invalid date controls', async () => {
    vi.mocked(getDashboardReport).mockResolvedValue(dashboard);
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/reports?from=2026-07-01&to=2026-07-31']}>
        <ReportsDashboard />
      </MemoryRouter>,
    ));
    await act(async () => { await Promise.resolve(); });

    const from = container.querySelector<HTMLInputElement>('input[name="from"]')!;
    const to = container.querySelector<HTMLInputElement>('input[name="to"]')!;
    from.value = '2026-07-31';
    to.value = '2026-07-01';
    await act(async () => {
      from.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise(requestAnimationFrame);
    });

    const summary = container.querySelector<HTMLElement>('#report-filter-error');
    expect(summary?.matches('[role="alert"][tabindex="-1"]')).toBe(true);
    expect(summary?.querySelector('h2')?.textContent).toBe('Filtreleri kontrol edin');
    expect(document.activeElement).toBe(summary);
    for (const input of [from, to]) {
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')).toBe('report-filter-error');
    }
  });
});
