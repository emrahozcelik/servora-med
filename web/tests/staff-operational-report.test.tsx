/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  StaffOperationalReport,
  StaffOperationalReportScreen,
} from '../src/reports/StaffOperationalReport';
import { getOwnStaffReport, getStaffReport } from '../src/reports/reports-api';
import type { StaffReportResponse } from '../src/reports/report-types';

vi.mock('../src/reports/reports-api', () => ({
  getOwnStaffReport: vi.fn(),
  getStaffReport: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const report: StaffReportResponse = {
  staff: { userId: STAFF_ID, name: 'Emrah Demir', isActive: false },
  range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
  counters: { openJobCards: 3, waitingApproval: 2, revisionRequested: 1,
    overdueJobCards: 1, completedInPeriod: 4 },
  deliveriesByPurpose: [
    { purpose: 'SALE', unit: 'Kutu', quantity: '12.500' },
    { purpose: 'SAMPLE', unit: null, quantity: '3.000' },
  ],
  meetingsByOutcome: [
    { outcome: 'POSITIVE', count: 1 }, { outcome: 'FOLLOW_UP_REQUIRED', count: 2 },
    { outcome: 'NO_DECISION', count: 0 }, { outcome: 'NOT_INTERESTED', count: 0 },
  ],
};

describe('Staff operational report', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(getOwnStaffReport).mockReset();
    vi.mocked(getStaffReport).mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('renders the echoed range, five counters, inactive state, and exact quantities', () => {
    const html = renderToStaticMarkup(<StaffOperationalReport report={report} />);
    expect(html).toContain('1 Temmuz 2026 – 31 Temmuz 2026');
    expect(html).toContain('Europe/Istanbul');
    expect(html).toContain('Pasif personel');
    for (const label of ['Açık işler', 'Onay bekliyor', 'Düzeltme istendi', 'Geciken', 'Dönemde tamamlandı']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Onaylı teslimler');
    expect(html).toContain('12.500');
    expect(html).toContain('Birim belirtilmedi');
    expect(html).toContain('Görüşme sonuçları');
    expect(html).toContain('Takip gerekli');
    expect(html).not.toMatch(/puan|sıralama|ciro|stok|komisyon|type="date"|select/i);
  });

  it('renders an explanatory no-delivery state', () => {
    const html = renderToStaticMarkup(<StaffOperationalReport report={{
      ...report, deliveriesByPurpose: [],
      meetingsByOutcome: report.meetingsByOutcome.map((item) => ({ ...item, count: 0 })),
    }} />);
    expect(html).toContain('Bu dönemde onaylı teslim bulunmuyor.');
    expect(html).toContain('Bu dönemde onaylı satış görüşmesi bulunmuyor.');
    expect((html.match(/<tr/g) ?? []).length).toBe(5);
  });

  it('loads the own report independently with the default range', async () => {
    let resolveReport!: (value: StaffReportResponse) => void;
    vi.mocked(getOwnStaffReport).mockReturnValue(new Promise((resolve) => {
      resolveReport = resolve;
    }));
    await act(async () => root.render(<StaffOperationalReportScreen onBack={() => {}} />));
    expect(container.textContent).toContain('Operasyon raporu yükleniyor');
    await act(async () => resolveReport(report));
    expect(getOwnStaffReport).toHaveBeenCalledWith(null);
    expect(container.textContent).toContain('12.500');
  });

  it('shows a safe error and retries the management report', async () => {
    vi.mocked(getStaffReport)
      .mockRejectedValueOnce(new Error('Personel profili bulunamadı.'))
      .mockResolvedValueOnce(report);
    await act(async () => root.render(
      <StaffOperationalReportScreen staffUserId={STAFF_ID} onBack={() => {}} />,
    ));
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Personel profili bulunamadı.');
    const retry = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Tekrar dene')!;
    await act(async () => retry.click());
    await act(async () => { await Promise.resolve(); });
    expect(getStaffReport).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Onaylı teslimler');
  });
});
