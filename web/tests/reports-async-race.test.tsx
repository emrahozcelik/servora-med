/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeliveryReport } from '../src/reports/DeliveryReport';
import { ReportsDashboard } from '../src/reports/ReportsDashboard';
import {
  getDashboardReport,
  getDeliveryReport,
} from '../src/reports/reports-api';
import type {
  DashboardReportResponse,
  DeliveryReportResponse,
} from '../src/reports/report-types';
import { resolveDatePreset } from '../src/reports/report-range';
import { ReportDateRangeForm } from '../src/reports/report-shell';
import { listStaff } from '../src/services/people-api';

vi.mock('../src/reports/reports-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/reports/reports-api')>(),
  getDashboardReport: vi.fn(),
  getDeliveryReport: vi.fn(),
}));

vi.mock('../src/services/people-api', () => ({
  listStaff: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function SearchProbe() {
  const [search] = useSearchParams();
  return <output data-report-search>{search.toString()}</output>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function dashboardFor(from: string, to: string, timezone = 'UTC'): DashboardReportResponse {
  return {
    range: { from, to, timezone },
    counters: {
      activeJobCards: 1, overdueJobCards: 0, waitingApproval: 0,
      revisionRequested: 0, completedInPeriod: from === '2026-07-01' ? 7 : 30,
      cancelledInPeriod: 0,
    },
    completedTrend: [{ date: from, count: from === '2026-07-01' ? 7 : 30 }],
    dailyCreatedTrend: [{ date: from, count: from === '2026-07-01' ? 7 : 30 }],
    activeStatusDistribution: [
      { status: 'NEW', count: 1 },
      { status: 'ACCEPTED', count: 0 },
      { status: 'IN_PROGRESS', count: 0 },
      { status: 'WAITING_APPROVAL', count: 0 },
      { status: 'REVISION_REQUESTED', count: 0 },
    ],
    createdWorkTypeDistribution: [
      { type: 'PRODUCT_DELIVERY', count: 1 },
      { type: 'GENERAL_TASK', count: 0 },
      { type: 'SALES_MEETING', count: 0 },
    ],
  };
}

function deliveryFor(from: string, to: string, timezone = 'UTC'): DeliveryReportResponse {
  return {
    groupBy: 'day',
    items: [{ date: from, unit: 'adet', quantity: from.endsWith('01') ? '7.000' : '30.000' }],
    range: { from, to, timezone },
    total: 1,
    limit: 50,
    offset: 0,
  };
}

describe('report latest-request-wins', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(getDashboardReport).mockReset();
    vi.mocked(getDeliveryReport).mockReset();
    vi.mocked(listStaff).mockReset();
    vi.mocked(listStaff).mockResolvedValue([]);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('keeps the later dashboard range when an earlier request finishes last', async () => {
    const first = deferred<DashboardReportResponse>();
    const second = deferred<DashboardReportResponse>();
    vi.mocked(getDashboardReport)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/reports?from=2026-07-01&to=2026-07-07']}>
          <ReportsDashboard />
        </MemoryRouter>,
      );
    });

    // Second filter: last 30 days style range
    const fromInput = container.querySelector<HTMLInputElement>('input[name="from"]')!;
    const toInput = container.querySelector<HTMLInputElement>('input[name="to"]')!;
    fromInput.value = '2026-06-08';
    toInput.value = '2026-07-07';
    await act(async () => {
      fromInput.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await act(async () => {
      second.resolve(dashboardFor('2026-06-08', '2026-07-07', 'America/New_York'));
      await second.promise;
      await Promise.resolve();
    });

    expect(container.textContent).toContain('30');
    expect(container.querySelector('.report-nav a[href*="deliveries"]')?.getAttribute('href'))
      .toContain('from=2026-06-08');

    await act(async () => {
      first.resolve(dashboardFor('2026-07-01', '2026-07-07', 'America/New_York'));
      await first.promise;
      await Promise.resolve();
    });

    // Stale first response must not overwrite later range content.
    expect(container.textContent).toContain('Seçilen dönemde oluşturulan ve tamamlanan işlerin günlük sayısı.');
    expect(container.textContent).toMatch(/30/);
    expect(container.textContent).not.toMatch(/>\s*7\s*</);
    const completed = [...container.querySelectorAll('.report-executive-metrics dd')]
      .map((node) => node.textContent);
    expect(completed).toContain('30');
    expect(completed).not.toContain('7');
  });

  it('disables presets until organization timezone is resolved', async () => {
    const pending = deferred<DashboardReportResponse>();
    vi.mocked(getDashboardReport).mockImplementationOnce(() => pending.promise);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/reports']}>
          <ReportsDashboard />
        </MemoryRouter>,
      );
    });

    const presets = container.querySelectorAll<HTMLButtonElement>('.report-preset-button');
    expect(presets.length).toBeGreaterThan(0);
    for (const button of presets) expect(button.disabled).toBe(true);

    await act(async () => {
      pending.resolve(dashboardFor('2026-07-01', '2026-07-31', 'America/New_York'));
      await pending.promise;
      await Promise.resolve();
    });

    for (const button of container.querySelectorAll<HTMLButtonElement>('.report-preset-button')) {
      expect(button.disabled).toBe(false);
    }
  });

  it('keeps the applied preset selected while entering custom range editing', async () => {
    vi.mocked(getDashboardReport).mockResolvedValue(
      dashboardFor('2026-07-01', '2026-07-31', 'America/New_York'),
    );

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/reports?from=2026-07-01&to=2026-07-31']}>
          <ReportsDashboard />
          <SearchProbe />
        </MemoryRouter>,
      );
      await Promise.resolve();
    });

    const labels = [...container.querySelectorAll<HTMLButtonElement>('.report-preset-button')]
      .map((button) => button.textContent);
    expect(labels).toEqual(['Son 7 gün', 'Son 30 gün', 'Son 90 gün', 'Bu ay', 'Özel aralık']);

    const last90 = [...container.querySelectorAll<HTMLButtonElement>('.report-preset-button')]
      .find((button) => button.textContent === 'Son 90 gün');
    expect(last90).toBeDefined();
    const expectedRange = resolveDatePreset('last90', 'America/New_York');
    vi.mocked(getDashboardReport).mockClear();
    await act(async () => {
      last90!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(last90?.getAttribute('aria-pressed')).toBe('true');
    expect(getDashboardReport).toHaveBeenLastCalledWith(expectedRange);
    const selectedSearch = new URLSearchParams(
      container.querySelector<HTMLOutputElement>('[data-report-search]')?.textContent ?? '',
    );
    expect(selectedSearch.get('from')).toBe(expectedRange.from);
    expect(selectedSearch.get('to')).toBe(expectedRange.to);

    const custom = [...container.querySelectorAll<HTMLButtonElement>('.report-preset-button')]
      .find((button) => button.textContent === 'Özel aralık');
    await act(async () => {
      custom!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(custom?.getAttribute('aria-pressed')).toBe('false');
    expect(last90?.getAttribute('aria-pressed')).toBe('true');
  });

  it('does not add pressed semantics to shared presets without selected-state management', async () => {
    await act(async () => {
      root.render(
        <ReportDateRangeForm
          formKey="shared"
          from="2026-07-01"
          to="2026-07-31"
          filterError=""
          errorRef={{ current: null }}
          onSubmit={vi.fn()}
          onPreset={vi.fn()}
        />,
      );
    });

    expect([...container.querySelectorAll<HTMLButtonElement>('.report-preset-button')]
      .every((button) => !button.hasAttribute('aria-pressed'))).toBe(true);
  });

  it('keeps later delivery range when an earlier request finishes last', async () => {
    const first = deferred<DeliveryReportResponse>();
    const second = deferred<DeliveryReportResponse>();
    vi.mocked(getDeliveryReport)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/reports/deliveries?from=2026-07-01&to=2026-07-07&groupBy=day&offset=0']}>
          <DeliveryReport user={{
            id: 'u1', organizationId: 'o1', name: 'Admin', email: 'a@x', role: 'ADMIN',
            mustChangePassword: false, isActive: true, version: 1,
          }} />
        </MemoryRouter>,
      );
    });

    const fromInput = container.querySelector<HTMLInputElement>('input[name="from"]')!;
    const toInput = container.querySelector<HTMLInputElement>('input[name="to"]')!;
    fromInput.value = '2026-06-08';
    toInput.value = '2026-07-07';
    await act(async () => {
      fromInput.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await act(async () => {
      second.resolve(deliveryFor('2026-06-08', '2026-07-07', 'UTC'));
      await second.promise;
      await Promise.resolve();
    });
    expect(container.textContent).toContain('30.000');

    await act(async () => {
      first.resolve(deliveryFor('2026-07-01', '2026-07-07', 'UTC'));
      await first.promise;
      await Promise.resolve();
    });
    expect(container.textContent).toContain('30.000');
    expect(container.textContent).not.toContain('7.000');
  });
});
