/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomerReport, CustomerReportView } from '../src/reports/CustomerReport';
import { getCustomerReport } from '../src/reports/reports-api';
import { resolveDatePreset } from '../src/reports/report-range';
import type { CustomerReportResponse } from '../src/reports/report-types';

vi.mock('../src/reports/reports-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/reports/reports-api')>(),
  getCustomerReport: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn().mockReturnValue({
  matches: true, media: '(min-width: 64rem)', addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}) });

const DISCLOSURE = 'Seçilen dönem metrikleri, iş kartlarının rapor anındaki mevcut müşteri bağlantısına göre gruplanır.';

const snapshot = { active: 4, actionable: 2, waitingApproval: 1,
  revisionRequested: 0, overdue: 1 };
const zeroSnapshot = { active: 0, actionable: 0, waitingApproval: 0,
  revisionRequested: 0, overdue: 0 };
const period = { created: 3,
  createdWorkTypes: { PRODUCT_DELIVERY: 2, GENERAL_TASK: 1, SALES_MEETING: 0 },
  managerApproved: 2, followUpChildren: 1 };
const zeroPeriod = { created: 0,
  createdWorkTypes: { PRODUCT_DELIVERY: 0, GENERAL_TASK: 0, SALES_MEETING: 0 },
  managerApproved: 0, followUpChildren: 0 };

const activeRow = { customer: { id: 'customer-1', name: 'Klinik A',
  customerType: 'clinic', status: 'active' },
activity: { snapshot, period } };
const inactiveRow = { customer: { id: 'customer-2', name: 'Hastane B',
  customerType: 'hospital', status: 'inactive' },
activity: { snapshot: zeroSnapshot, period: zeroPeriod } };
const zeroPeriodRow = { customer: { id: 'customer-3', name: 'Bayi C',
  customerType: 'dealer', status: 'prospect' },
activity: { snapshot, period: zeroPeriod } };

const baseReport = (overrides: Partial<CustomerReportResponse> = {}): CustomerReportResponse => ({
  range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
  total: 2, limit: 50, offset: 0, items: [activeRow, inactiveRow],
  unassigned: { snapshot, period },
  ...overrides,
});

function markup(report: CustomerReportResponse, filtersActive = false) {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <MemoryRouter>
      <CustomerReportView report={report} filtersActive={filtersActive} />
    </MemoryRouter>,
  );
  return container;
}

describe('Customer report presentation', () => {
  it('renders a structured customer list with drill-through names', () => {
    const view = markup(baseReport());
    const list = view.querySelector('ul.report-customer-list');
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll('li.report-customer-card')).toHaveLength(2);
    const first = list?.querySelector('a[href="/customers/customer-1"]');
    expect(first?.textContent).toBe('Klinik A');
    expect(first?.getAttribute('aria-label')).toBe('Klinik A müşterisini aç');
    expect(list?.querySelector('a[href="/customers/customer-2"]')?.textContent).toBe('Hastane B');
  });

  it('shows Şu an and Seçilen dönem group headings with all metric labels', () => {
    const view = markup(baseReport());
    expect(view.textContent).toContain('Şu an');
    expect(view.textContent).toContain('Seçilen dönem');
    for (const label of ['Aktif işler', 'Aksiyon alınabilir', 'Onay bekliyor',
      'Düzeltme bekliyor', 'Gecikmiş']) {
      expect(view.textContent).toContain(label);
    }
    for (const label of ['Oluşturulan işler', 'Yönetici onaylı tamamlananlar',
      'Oluşturulan takip işleri']) {
      expect(view.textContent).toContain(label);
    }
  });

  it('discloses current-customer attribution under the collection heading', () => {
    const view = markup(baseReport());
    const hint = view.querySelector('.report-customer-collection > .report-section-hint');
    expect(hint?.textContent).toBe(DISCLOSURE);
  });

  it('keeps customer status textual and inactive customers readable', () => {
    const view = markup(baseReport());
    const rows = view.querySelectorAll('li.report-customer-card');
    expect(rows[0]?.textContent).toContain('Aktif');
    expect(rows[0]?.textContent).toContain('Klinik');
    expect(rows[1]?.textContent).toContain('Pasif');
    expect(rows[1]?.textContent).toContain('Hastane');
    expect(rows[1]?.querySelector('a[href="/customers/customer-2"]')).not.toBeNull();
  });

  it('shows bounded work-type chips for the three canonical types', () => {
    const view = markup(baseReport());
    const chips = [...view.querySelectorAll('.report-customer-work-types span')]
      .map((chip) => chip.textContent);
    expect(chips).toEqual(['Ürün teslimi 2', 'Genel görev 1', 'Satış görüşmesi 0']);
  });

  it('separates unassigned jobs into their own section above the collection', () => {
    const view = markup(baseReport());
    const unassigned = view.querySelector('.report-customer-unassigned');
    const collection = view.querySelector('.report-customer-collection');
    expect(unassigned).not.toBeNull();
    expect(unassigned?.textContent).toContain('Müşteri ilişkilendirilmemiş işler');
    expect(view.textContent.indexOf('Müşteri ilişkilendirilmemiş işler'))
      .toBeLessThan(view.textContent.indexOf('Müşteriler'));
    expect(unassigned?.querySelector('ul, a')).toBeNull();
    expect(unassigned?.querySelector('.report-customer-list')).toBeNull();
    expect(collection?.querySelector('.report-customer-list')).not.toBeNull();
  });

  it('limits unassigned metrics to active, overdue, created, and approved', () => {
    const view = markup(baseReport());
    const unassigned = view.querySelector('.report-customer-unassigned')!;
    for (const label of ['Aktif işler', 'Gecikmiş', 'Oluşturulan işler',
      'Yönetici onaylı tamamlananlar']) {
      expect(unassigned.textContent).toContain(label);
    }
    for (const label of ['Aksiyon alınabilir', 'Oluşturulan takip işleri', 'Ürün teslimi']) {
      expect(unassigned.textContent).not.toContain(label);
    }
  });

  it('shows the unassigned zero copy when no jobs are unassigned', () => {
    const view = markup(baseReport({ unassigned: { snapshot: zeroSnapshot, period: zeroPeriod } }));
    expect(view.textContent).toContain('Şu an müşteri ilişkilendirilmemiş iş bulunmuyor.');
  });

  it('shows row-level zero copy only inside a customer with no period activity', () => {
    const view = markup(baseReport({ total: 3, items: [activeRow, zeroPeriodRow] }));
    const rows = view.querySelectorAll('li.report-customer-card');
    expect(rows[0]?.textContent).not.toContain('Seçilen dönemde iş kaydı yok.');
    expect(rows[1]?.textContent).toContain('Seçilen dönemde iş kaydı yok.');
    expect(view.textContent).not.toContain('Seçilen dönemde iş kaydı bulunmuyor.');
  });

  it('never infers a global period-empty state from a populated page', () => {
    const view = markup(baseReport({ total: 3, items: [activeRow, zeroPeriodRow] }));
    expect(view.textContent).not.toContain('Henüz müşteri kaydı yok.');
    expect(view.textContent).not.toContain('Filtrelere uygun müşteri bulunamadı.');
    expect(view.textContent).not.toContain('Bu sayfada gösterilecek kayıt kalmadı.');
  });

  it('distinguishes the no-customer empty state from a filtered no-match state', () => {
    const empty = markup(baseReport({ total: 0, items: [] }));
    expect(empty.textContent).toContain('Henüz müşteri kaydı yok.');
    expect(empty.textContent).not.toContain('Filtrelere uygun müşteri bulunamadı.');
    const filtered = markup(baseReport({ total: 0, items: [] }), true);
    expect(filtered.textContent).toContain('Filtrelere uygun müşteri bulunamadı.');
    expect(filtered.textContent).toContain('Filtreleri sıfırla');
    expect(filtered.textContent).not.toContain('Henüz müşteri kaydı yok.');
  });
});

describe('Customer report screen', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(getCustomerReport).mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(path: string) {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <CustomerReport />
        </MemoryRouter>,
      );
    });
    await act(async () => { await Promise.resolve(); });
  }

  it('loads the customer report from the parsed URL state', async () => {
    vi.mocked(getCustomerReport).mockResolvedValue(baseReport());
    await render('/reports/customers?from=2026-07-01&to=2026-07-31&search=Klinik&status=active&customerType=clinic&offset=0');
    expect(getCustomerReport).toHaveBeenCalledWith(expect.objectContaining({
      search: 'Klinik', status: 'active', customerType: 'clinic',
      requestedRange: { from: '2026-07-01', to: '2026-07-31' }, offset: 0, limit: 50,
    }));
    expect(container.textContent).toContain('Klinik A');
  });

  it('applies filters on explicit submit and resets the offset', async () => {
    vi.mocked(getCustomerReport).mockResolvedValue(baseReport());
    await render('/reports/customers?from=2026-07-01&to=2026-07-31&offset=50');
    const searchInput = container.querySelector<HTMLInputElement>('input[name="search"]')!;
    searchInput.value = 'Hastane';
    await act(async () => {
      searchInput.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(getCustomerReport).toHaveBeenLastCalledWith(expect.objectContaining({
      search: 'Hastane', status: null, customerType: null, offset: 0,
    }));
  });

  it('reset filters clears search, status, and type but preserves from/to', async () => {
    vi.mocked(getCustomerReport).mockResolvedValue(baseReport());
    function Location() { return <output data-location>{useLocation().search}</output>; }
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/reports/customers?from=2026-07-01&to=2026-07-31&search=Klinik&status=active&customerType=clinic&offset=50']}>
          <CustomerReport />
          <Location />
        </MemoryRouter>,
      );
    });
    await act(async () => { await Promise.resolve(); });
    const reset = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Filtreleri sıfırla'));
    await act(async () => { reset!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('[data-location]')?.textContent).toBe(
      '?from=2026-07-01&to=2026-07-31&offset=0',
    );
    expect(getCustomerReport).toHaveBeenLastCalledWith(expect.objectContaining({
      search: '', status: null, customerType: null, offset: 0,
    }));
  });

  it('offers recovery when the page is empty but records exist, without loops', async () => {
    vi.mocked(getCustomerReport).mockResolvedValue(
      baseReport({ total: 2, limit: 1, offset: 2, items: [] }),
    );
    function Location() { return <output data-location>{useLocation().search}</output>; }
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/reports/customers?from=2026-07-01&to=2026-07-31&offset=2']}>
          <CustomerReport />
          <Location />
        </MemoryRouter>,
      );
    });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('Bu sayfada gösterilecek kayıt kalmadı.');
    expect(container.textContent).not.toContain('Henüz müşteri kaydı yok.');
    expect(container.textContent).not.toContain('Filtrelere uygun müşteri bulunamadı.');
    const recover = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Önceki sayfaya dön'))!;
    await act(async () => { recover.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('[data-location]')?.textContent).toBe(
      '?from=2026-07-01&to=2026-07-31&offset=1',
    );
    expect(getCustomerReport).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1 }));
  });

  it('paginates with an N müşteri summary and bounded navigation', async () => {
    vi.mocked(getCustomerReport).mockResolvedValue(baseReport());
    await render('/reports/customers?from=2026-07-01&to=2026-07-31&offset=0');
    const pagination = container.querySelector('.report-pagination')!;
    expect(pagination.textContent).toContain('2 müşteri');
    const [previous, next] = pagination.querySelectorAll('button');
    expect((previous as HTMLButtonElement).disabled).toBe(true);
    expect((next as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders the shared date presets disabled until the organization timezone resolves', async () => {
    vi.mocked(getCustomerReport).mockReturnValue(new Promise<never>(() => {}));
    await render('/reports/customers?from=2026-07-01&to=2026-07-31&offset=0');
    const presets = [...container.querySelectorAll<HTMLButtonElement>('.report-preset-button')]
      .map((button) => button.textContent);
    expect(presets).toEqual(['Bugün', 'Son 7 gün', 'Son 30 gün', 'Bu ay']);
    for (const button of container.querySelectorAll<HTMLButtonElement>('.report-preset-button')) {
      expect(button.disabled).toBe(true);
    }
  });

  it('applies a preset with the resolved timezone, preserving filters and resetting the offset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T10:00:00.000Z'));
    try {
      vi.mocked(getCustomerReport).mockResolvedValue(baseReport());
      function Location() { return <output data-location>{useLocation().search}</output>; }
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={['/reports/customers?from=2026-07-01&to=2026-07-31&search=Klinik&status=active&customerType=clinic&offset=50']}>
            <CustomerReport />
            <Location />
          </MemoryRouter>,
        );
      });
      await act(async () => { await Promise.resolve(); });

      const presets = [...container.querySelectorAll<HTMLButtonElement>('.report-preset-button')]
        .map((button) => button.textContent);
      expect(presets).toEqual(['Bugün', 'Son 7 gün', 'Son 30 gün', 'Bu ay']);
      for (const button of container.querySelectorAll<HTMLButtonElement>('.report-preset-button')) {
        expect(button.disabled).toBe(false);
      }

      const last7 = [...container.querySelectorAll<HTMLButtonElement>('.report-preset-button')]
        .find((button) => button.textContent === 'Son 7 gün')!;
      const expected = resolveDatePreset('last7', 'Europe/Istanbul',
        new Date('2026-07-15T10:00:00.000Z'));
      vi.mocked(getCustomerReport).mockClear();
      await act(async () => {
        last7.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.querySelector('[data-location]')?.textContent).toBe(
        `?from=${expected.from}&to=${expected.to}&search=Klinik&status=active&customerType=clinic&offset=0`,
      );
      expect(getCustomerReport).toHaveBeenLastCalledWith(expect.objectContaining({
        search: 'Klinik', status: 'active', customerType: 'clinic',
        requestedRange: { from: expected.from, to: expected.to }, offset: 0,
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});