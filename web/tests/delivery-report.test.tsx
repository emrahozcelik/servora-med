/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeliveryReport, DeliveryReportView } from '../src/reports/DeliveryReport';
import { getDeliveryReport } from '../src/reports/reports-api';
import { listStaff } from '../src/services/people-api';
import type { CurrentUser } from '../src/services/api';
import type { DeliveryReportResponse } from '../src/reports/report-types';

vi.mock('../src/reports/reports-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/reports/reports-api')>(),
  getDeliveryReport: vi.fn(),
}));
vi.mock('../src/services/people-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/people-api')>(),
  listStaff: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn().mockReturnValue({
  matches: true, media: '(min-width: 64rem)', addEventListener: vi.fn(), removeEventListener: vi.fn(),
}) });

const manager: CurrentUser = {
  id: 'm1', organizationId: 'o1', name: 'M', email: 'm@t.local', role: 'MANAGER',
  mustChangePassword: false, isActive: true, version: 1,
};

const base = {
  range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
  total: 1, limit: 50, offset: 0,
};

describe('Delivery report presentation', () => {
  it.each([
    [{ ...base, groupBy: 'day', items: [{ date: '2026-07-14', unit: null, quantity: '0.500' }] }, ['Tarih', 'Birim', 'Miktar']],
    [{ ...base, groupBy: 'purpose', items: [{ purpose: 'SALE', unit: 'Kutu', quantity: '3.000' }] }, ['Amaç', 'Birim', 'Miktar']],
    [{ ...base, groupBy: 'product', items: [{ productId: 'p1', productNameSnapshot: 'İmplant Seti', productSkuSnapshot: 'SKU-1', productModelSnapshot: 'M1', unit: 'Kutu', quantity: '12.500' }] }, ['Ürün', 'SKU', 'Model', 'Birim', 'Miktar']],
    [{ ...base, groupBy: 'staff', items: [{ staff: { userId: 's1', name: 'Ayşe', isActive: false }, unit: 'Kutu', quantity: '3.000' }] }, ['Personel', 'Birim', 'Miktar']],
  ] as Array<[DeliveryReportResponse, string[]]>)('renders desktop and mobile parity for group-specific columns', (report, headings) => {
    const html = renderToStaticMarkup(<DeliveryReportView report={report} />);
    expect(html).toContain('data-servora-operational-table="true"');
    expect(html).toContain('Teslim miktarları (birim kırılımları birleştirilmez)');
    expect(html).toContain('servora-operational-table__mobile-caption');
    headings.forEach((heading) => {
      expect(html).toContain(`>${heading}</th>`);
      expect(html).toContain(`<dt>${heading}</dt>`);
    });
    expect(html).toContain(report.items[0]!.quantity);
    // Quantity appears on both surfaces as the same prepared string.
    const quantityMatches = html.match(new RegExp(report.items[0]!.quantity, 'g')) ?? [];
    expect(quantityMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('explains an empty approved-delivery result', () => {
    const html = renderToStaticMarkup(<DeliveryReportView report={{ ...base, groupBy: 'day', items: [] }} />);
    expect(html).toContain('Seçilen dönemde onaylı teslim bulunmuyor.');
  });
});

describe('DeliveryReport controls and pagination', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.mocked(getDeliveryReport).mockReset();
    vi.mocked(listStaff).mockResolvedValue([]);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('renders ServoraListPagination, active preset state, and Filtreleri sıfırla', async () => {
    vi.mocked(getDeliveryReport).mockResolvedValue({
      ...base,
      groupBy: 'purpose',
      items: [{ purpose: 'SALE', unit: 'Kutu', quantity: '3.000' }],
      total: 60,
      limit: 50,
      offset: 0,
    });
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/reports/deliveries?groupBy=purpose']}>
        <DeliveryReport user={manager} />
      </MemoryRouter>,
    ));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain('Sayfa 1 / 2 · Toplam 60 grup');
    expect(host.querySelector('.servora-list-pagination')).not.toBeNull();
    const reset = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Filtreleri sıfırla');
    expect(reset).toBeTruthy();

    const presetBtn = Array.from(host.querySelectorAll('.report-preset-button'))
      .find((b) => b.textContent === 'Son 7 gün') as HTMLButtonElement;
    await act(async () => presetBtn.click());
    expect(presetBtn.getAttribute('aria-pressed')).toBe('true');
  });
});
