import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DeliveryReportView } from '../src/reports/DeliveryReport';
import type { DeliveryReportResponse } from '../src/reports/report-types';

const base = {
  range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
  total: 1, limit: 50, offset: 0,
};

describe('Delivery report presentation', () => {
  it.each([
    [{ ...base, groupBy: 'day', items: [{ date: '2026-07-14', unit: null, quantity: '0.500' }] }, ['Tarih', 'Birim', 'Miktar']],
    [{ ...base, groupBy: 'purpose', items: [{ purpose: 'SALE', unit: 'Kutu', quantity: '3.000' }] }, ['Amaç', 'Birim', 'Miktar']],
    [{ ...base, groupBy: 'product', items: [{ productId: 'p1', productNameSnapshot: 'İmplant Seti', productSkuSnapshot: null, productModelSnapshot: null, unit: 'Kutu', quantity: '12.500' }] }, ['Ürün', 'Model', 'Birim', 'Miktar']],
    [{ ...base, groupBy: 'staff', items: [{ staff: { userId: 's1', name: 'Ayşe', isActive: false }, unit: 'Kutu', quantity: '3.000' }] }, ['Personel', 'Birim', 'Miktar']],
  ] as Array<[DeliveryReportResponse, string[]]>)('renders the exact group-specific table', (report, headings) => {
    const html = renderToStaticMarkup(<DeliveryReportView report={report} />);
    headings.forEach((heading) => expect(html).toContain(heading));
    expect(html).toContain(report.items[0]!.quantity);
    expect(html).not.toMatch(/parseFloat|NaN/);
  });

  it('explains an empty approved-delivery result', () => {
    const html = renderToStaticMarkup(<DeliveryReportView report={{ ...base, groupBy: 'day', items: [] }} />);
    expect(html).toContain('Seçilen dönemde onaylı teslim bulunmuyor.');
  });
});
