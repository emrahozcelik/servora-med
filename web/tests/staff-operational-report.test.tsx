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
    { type: 'SALES_MEETING', count: 0 },
  ],
  currentWorkloadByType: [
    { type: 'PRODUCT_DELIVERY', count: 1 },
    { type: 'GENERAL_TASK', count: 1 },
    { type: 'SALES_MEETING', count: 1 },
  ],
  staffSubmissionAttribution: { recordedSubmissionCount: 2, recordedSubmissionDays: 2 },
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

  it('renders purpose-layered snapshot and selected-period operational detail', () => {
    const html = renderToStaticMarkup(<StaffOperationalReport report={report} />);
    expect(html).toContain('1 Temmuz 2026 – 31 Temmuz 2026');
    expect(html).toContain('Europe/Istanbul');
    expect(html).toContain('Pasif personel');
    expect(html).toContain('Seçilen dönemde onaya gönderme atfı bu personele kayıtlı işleri gösterir.');
    expect(html).not.toContain('Onaya gönderme kaydı, mevcut atama üzerinde');
    expect(html).toContain('hâlen bu personele atanmış');
    for (const label of [
      'Şu an — mevcut operasyon yükü', 'Seçilen dönem — yönetici onaylı sonuçlar',
      'Aksiyon alınabilir', 'Gecikmiş', 'Onay bekliyor', 'Düzeltme bekliyor',
      'Yönetici onaylı tamamlananlar', 'Onaya gönderme kaydı',
      'Eklenen operasyon notları', 'Mevcut iş yükünün tür dağılımı',
      'Tamamlanan işlerin türleri',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Dönem içindeki yönetici onaylı tamamlanmalar');
    expect(html).toContain('data-report-trend-bars="true"');
    expect(html).toContain('Günlük yönetici onaylı tamamlanmalar');
    expect(html).toContain('Mevcut iş yükünün tür dağılımı');
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
    // Every first-row value is emitted by both the desktop table and mobile card.
    for (const value of ['Satış', 'Kutu', '12.500', 'Olumlu']) {
      expect((html.match(new RegExp(value, 'g')) ?? []).length).toBeGreaterThanOrEqual(2);
    }
    expect(html).not.toMatch(/performans|puan|sıralama|ciro|stok|komisyon|Personelin bitirme zamanı|Mevcut plana göre zamanında|type="date"|select/i);
  });

  it('does not promote legacy comparison fields into the operational presentation', () => {
    const html = renderToStaticMarkup(<StaffOperationalReport report={{
      ...report,
      priorPerformance: { available: false, performance: null },
    }} />);
    expect(html).toContain('Seçilen dönem — yönetici onaylı sonuçlar');
    expect(html).not.toContain('Önceki dönem verisi yok');
    expect(html).not.toContain('İş / gün');
    expect(html).not.toContain('Personelin bitirme zamanı');
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
    expect(container.textContent).toContain('Personel operasyon raporu yükleniyor');
    expect(container.querySelector('[data-servora-loading-skeleton="true"]')).not.toBeNull();
    const loadingTitle = container.querySelector('.servora-loading-skeleton__title');
    expect(loadingTitle?.textContent).toBe('Personel operasyon raporu yükleniyor');
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

  it('ignores stale detail success after a newer range request', async () => {
    let resolveFirst!: (value: StaffReportResponse) => void;
    let rejectSecond!: (reason: Error) => void;
    vi.mocked(getStaffReport)
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSecond = reject; }));

    await act(async () => root.render(
      <StaffOperationalReportScreen
        staffUserId={STAFF_ID}
        requestedRange={{ from: '2026-07-01', to: '2026-07-31' }}
        onBack={() => {}}
      />,
    ));
    await act(async () => root.render(
      <StaffOperationalReportScreen
        staffUserId={STAFF_ID}
        requestedRange={{ from: '2026-08-01', to: '2026-08-31' }}
        onBack={() => {}}
      />,
    ));

    await act(async () => rejectSecond(new Error('Yeni dönem alınamadı.')));
    await act(async () => resolveFirst(report));

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Yeni dönem alınamadı.');
    expect(container.textContent).not.toContain('12.500');
  });

  it('ignores stale detail error after a newer range succeeds', async () => {
    let rejectFirst!: (reason: Error) => void;
    let resolveSecond!: (value: StaffReportResponse) => void;
    const newerReport = { ...report, staff: { ...report.staff, name: 'Yeni Dönem Personeli' } };
    vi.mocked(getStaffReport)
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));

    await act(async () => root.render(
      <StaffOperationalReportScreen
        staffUserId={STAFF_ID}
        requestedRange={{ from: '2026-07-01', to: '2026-07-31' }}
        onBack={() => {}}
      />,
    ));
    await act(async () => root.render(
      <StaffOperationalReportScreen
        staffUserId={STAFF_ID}
        requestedRange={{ from: '2026-08-01', to: '2026-08-31' }}
        onBack={() => {}}
      />,
    ));

    await act(async () => resolveSecond(newerReport));
    await act(async () => rejectFirst(new Error('Eski dönem hatası.')));

    expect(container.textContent).toContain('Yeni Dönem Personeli');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
