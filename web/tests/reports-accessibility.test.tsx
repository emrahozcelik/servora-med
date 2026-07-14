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

  it('keeps the visual trend decorative and exposes every value in a semantic table', () => {
    const view = markup(<ReportsDashboardView report={dashboard} />);
    expect(view.querySelector('.completed-trend')?.getAttribute('aria-hidden')).toBe('true');
    expect(view.querySelector('table caption')?.textContent)
      .toBe('Tamamlanan işlerin günlük dağılımı');
    expect(view.querySelectorAll('table thead th[scope="col"]')).toHaveLength(2);
    expect(view.querySelectorAll('table tbody th[scope="row"]')).toHaveLength(2);
    expect(view.querySelector('table')?.textContent).toContain('2 Tem 2026');
    expect(view.querySelector('table')?.textContent).toContain('0');
  });

  it('gives delivery and Staff tables captions, scoped headers, and mobile row labels', () => {
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
      counters: { openJobCards: 1, waitingApproval: 2, revisionRequested: 3,
        overdueJobCards: 4, completedInPeriod: 5 },
      deliveriesByPurpose: delivery.items,
    };

    for (const view of [
      markup(<DeliveryReportView report={delivery} />),
      markup(<StaffOperationalReport report={staff} />),
    ]) {
      expect(view.querySelector('table caption')?.textContent).not.toBe('');
      expect(view.querySelectorAll('thead th[scope="col"]').length).toBeGreaterThan(0);
      expect(view.querySelector('tbody th[scope="row"]')).not.toBeNull();
      expect(view.querySelector('table')?.classList.contains('responsive-report-table')).toBe(true);
      expect(view.querySelectorAll('tbody [data-label]').length).toBeGreaterThan(0);
    }
    expect(markup(<StaffOperationalReport report={staff} />).textContent)
      .toContain('Pasif personel');
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
