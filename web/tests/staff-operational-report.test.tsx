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
  priorRange: { from: '2026-05-31', to: '2026-06-30', timezone: 'Europe/Istanbul' },
  performance: { completedJobs: 4, completionDays: 2, jobsPerCompletionDay: 2,
    correctionRequestEvents: 1, authoredOperationalNotes: 3 },
  priorPerformance: { available: true, performance: { completedJobs: 0,
    completionDays: 0, jobsPerCompletionDay: 0, correctionRequestEvents: 0,
    authoredOperationalNotes: 0 } },
  staffExecution: { staffCompletedJobs: 3,
    staffCompletionDays: 2, jobsPerStaffCompletionDay: 1.5,
    missingStaffCompletionTimestamp: 1 },
  onTime: { eligibleScheduledCompletedJobs: 3, onTimeCompletedJobs: 2,
    lateCompletedJobs: 1, ineligibleOrNoDeadlineCompletedJobs: 1, onTimeRate: 2 / 3 },
  completionWorkTypes: [
    { type: 'GENERAL_TASK', count: 3 },
    { type: 'PRODUCT_DELIVERY', count: 1 },
  ],
  completedTrend: [
    { date: '2026-07-01', count: 0 },
    { date: '2026-07-02', count: 4 },
  ],
  deliveriesByPurpose: [
    { purpose: 'SALE', unit: 'Kutu', quantity: '12.500' },
    { purpose: 'SAMPLE', unit: null, quantity: '3.000' },
  ],
  meetingsByOutcome: [
    { outcome: 'POSITIVE', count: 1 }, { outcome: 'FOLLOW_UP_REQUIRED', count: 2 },
    { outcome: 'NO_DECISION', count: 0 }, { outcome: 'NOT_INTERESTED', count: 0 },
  ],
  currentWorkload: { openJobCards: 3, waitingApproval: 2, revisionRequested: 1,
    overdueJobCards: 1 },
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

  it('renders historical performance and keeps the current snapshot last', () => {
    const html = renderToStaticMarkup(<StaffOperationalReport report={report} />);
    expect(html).toContain('1 Temmuz 2026 – 31 Temmuz 2026');
    expect(html).toContain('31 Mayıs 2026 – 30 Haziran 2026');
    expect(html).toContain('Europe/Istanbul');
    expect(html).toContain('Pasif personel');
    for (const label of [
      'Tamamlanan iş', 'Tamamlama günü', 'İş / gün', 'Düzeltme isteği', 'Eklediği not',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Günlük tamamlamalar');
    expect(html).toContain('Şimdi 4 · önceki 0');
    expect(html).not.toContain('Önceki dönem verisi yok');
    expect(html).toContain('Personelin bitirme zamanı');
    expect(html).toContain('Bitirme zamanı eksik onaylı iş');
    expect(html).toContain('Mevcut plana göre zamanında');
    expect(html).toContain('2 / 3 hesaplanabilir zaman hedefli iş');
    expect(html).toContain('Zaman hedefi olmayan / hesaplanamayan tamamlanan');
    expect(html).toContain('data-report-trend-bars="true"');
    expect(html).toContain('Günlük tamamlanan işler');
    expect(html).toContain('İş türleri');
    expect(html).toContain('Genel görev');
    expect(html).toContain('Onaylı teslimler');
    expect(html).toContain('12.500');
    expect(html).toContain('Birim belirtilmedi');
    expect(html).toContain('Görüşme sonuçları');
    expect(html).toContain('Takip gerekli');
    expect((html.match(/data-servora-operational-table="true"/g) ?? [])).toHaveLength(3);
    expect(html).toContain('<caption>Onaylı teslimler</caption>');
    expect(html).toContain('<caption>Görüşme sonuçları</caption>');
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Satış<\/th>/);
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Olumlu<\/th>/);
    for (const heading of ['Amaç', 'Birim', 'Miktar', 'Sonuç', 'Görüşme sayısı']) {
      expect(html).toContain(`<dt>${heading}</dt>`);
    }
    expect(html.lastIndexOf('Şu an')).toBeGreaterThan(html.lastIndexOf('Görüşme sonuçları'));
    for (const label of ['Açık işler', 'Gecikmiş', 'Onay bekliyor', 'Düzeltme bekliyor']) {
      expect(html).toContain(label);
    }
    // Every first-row value is emitted by both the desktop table and mobile card.
    for (const value of ['Satış', 'Kutu', '12.500', 'Olumlu']) {
      expect((html.match(new RegExp(value, 'g')) ?? []).length).toBeGreaterThanOrEqual(2);
    }
    expect(html).not.toMatch(/puan|sıralama|ciro|stok|komisyon|type="date"|select/i);
  });

  it('distinguishes an unavailable prior period from valid zero metrics', () => {
    const validZero = renderToStaticMarkup(<StaffOperationalReport report={report} />);
    expect(validZero).toContain('Şimdi 4 · önceki 0');
    expect(validZero).not.toContain('Önceki dönem verisi yok');

    const unavailable = renderToStaticMarkup(<StaffOperationalReport report={{
      ...report,
      priorPerformance: { available: false, performance: null },
    }} />);
    expect(unavailable).toContain('Önceki dönem verisi yok');
    expect(unavailable).not.toContain('Şimdi 4 · önceki 0');
  });

  it('renders an explanatory no-delivery state', () => {
    const html = renderToStaticMarkup(<StaffOperationalReport report={{
      ...report, deliveriesByPurpose: [],
      meetingsByOutcome: report.meetingsByOutcome.map((item) => ({ ...item, count: 0 })),
    }} />);
    expect(html).toContain('Bu dönemde onaylı teslim bulunmuyor.');
    expect(html).toContain('Bu dönemde onaylı satış görüşmesi bulunmuyor.');
    expect((html.match(/data-servora-operational-table="true"/g) ?? [])).toHaveLength(2);
    expect(html).not.toContain('<caption>Onaylı teslimler</caption>');
    expect(html).toContain('<caption>Görüşme sonuçları</caption>');
  });

  it('loads the own report independently with the default range', async () => {
    let resolveReport!: (value: StaffReportResponse) => void;
    vi.mocked(getOwnStaffReport).mockReturnValue(new Promise((resolve) => {
      resolveReport = resolve;
    }));
    await act(async () => root.render(<StaffOperationalReportScreen onBack={() => {}} />));
    expect(container.textContent).toContain('Operasyon raporu yükleniyor');
    expect(container.querySelector('[data-servora-loading-skeleton="true"]')).not.toBeNull();
    const loadingTitle = container.querySelector('.servora-loading-skeleton__title');
    expect(loadingTitle?.textContent).toBe('Operasyon raporu yükleniyor');
    expect(loadingTitle?.classList.contains('sr-only')).toBe(false);
    expect(loadingTitle?.querySelector('[role="status"]')?.closest('[aria-busy="true"]')).toBeNull();
    expect(container.querySelector('.servora-loading-skeleton__geometry[aria-busy="true"]'))
      .not.toBeNull();
    expect(container.querySelector('[aria-hidden="true"] .servora-loading-skeleton__content'))
      .not.toBeNull();
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
    expect(container.querySelector('[data-servora-result-state="true"]')).not.toBeNull();
    const retry = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Tekrar dene')!;
    await act(async () => retry.click());
    await act(async () => { await Promise.resolve(); });
    expect(getStaffReport).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Onaylı teslimler');
  });

  it('forwards the selected range to a management detail request', async () => {
    vi.mocked(getStaffReport).mockResolvedValue(report);
    const requestedRange = { from: '2026-07-01', to: '2026-07-31' };

    await act(async () => root.render(
      <StaffOperationalReportScreen
        staffUserId={STAFF_ID}
        requestedRange={requestedRange}
        backLabel="Personel performansına dön"
        onBack={() => {}}
      />,
    ));
    await act(async () => { await Promise.resolve(); });

    expect(getStaffReport).toHaveBeenCalledWith(STAFF_ID, requestedRange);
    expect(container.textContent).toContain('Personel performansına dön');
  });
});
