/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  StaffOperationalReport,
  StaffOperationalReportScreen,
} from '../src/reports/StaffOperationalReport';
import {
  getOwnStaffReport,
  getStaffReport,
  listOwnLatenessIncidents,
  listStaffLatenessIncidents,
} from '../src/reports/reports-api';
import type { StaffReportResponse } from '../src/reports/report-types';
import { renderWithRoute } from './route-test-helpers';

vi.mock('../src/reports/reports-api', () => ({
  getOwnStaffReport: vi.fn(),
  getStaffReport: vi.fn(),
  listOwnLatenessIncidents: vi.fn(),
  listStaffLatenessIncidents: vi.fn(),
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
  lateness: {
    trackingStartedOn: '2026-09-21',
    generatedAt: '2026-07-31T12:00:00.000Z',
    staffResponsibility: {
      delayedJobCount: 2,
      incidentCount: 3,
      byType: [
        { delayType: 'LATE_START', incidentCount: 2,
          recovered: { count: 1, medianSeconds: 8_100, maxSeconds: 8_100 },
          extended: { count: 1, medianSeconds: 90_000, maxSeconds: 90_000 },
          open: { count: 0, maxElapsedSeconds: null } },
        { delayType: 'LATE_SUBMISSION', incidentCount: 1,
          recovered: { count: 0, medianSeconds: null, maxSeconds: null },
          extended: { count: 0, medianSeconds: null, maxSeconds: null },
          open: { count: 1, maxElapsedSeconds: 7_200 } },
      ],
    },
    operational: {
      delayedJobCount: 2,
      incidentCount: 2,
      byReason: [
        { reasonCode: 'CUSTOMER_ABSENT', incidentCount: 1 },
        { reasonCode: 'MISSING_STOCK_OR_EQUIPMENT', incidentCount: 1 },
      ],
    },
  },
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
    vi.mocked(listOwnLatenessIncidents).mockReset();
    vi.mocked(listStaffLatenessIncidents).mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('renders purpose-layered snapshot and selected-period operational detail', () => {
    const html = renderToStaticMarkup(<StaffOperationalReport report={report} />);
    expect(html).toContain('1 Temmuz 2026 – 31 Temmuz 2026');
    expect(html).not.toContain('Europe/Istanbul');
    expect(html).not.toMatch(/\b(?:NEW|ACCEPTED|IN_PROGRESS)\b/);
    expect(html).toContain('Pasif personel');
    expect(html).toContain('tamamlandığı anda bu personele atanmış');
    expect(html).toContain('İşi bir yönetici onaya gönderse veya tamamlasa da atıf atanmış personelde kalır.');
    expect(html).toContain('Onaya gönderme kaydı bu atıftan ayrıdır ve işi kimin gönderdiğini gösterir.');
    expect(html).not.toContain('Onaya gönderme kaydı, mevcut atama üzerinde');
    expect(html).not.toContain('hâlen bu personele atanmış');
    expect(html).not.toContain('fiilen yapan');
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
    expect(html).toContain('Gecikme kayıtları');
    expect(html).toContain('Personel sorumluluğundaki gecikmeler');
    expect(html).toContain('Yönetimce sonuçlandırılan değişiklik talebiyle ilişkili gecikmeler');
    expect(html).toContain('Stok veya ekipman eksik');
    expect((html.match(/data-servora-operational-table="true"/g) ?? [])).toHaveLength(3);
    expect(html).toContain('<caption class="sr-only">Onaylı teslimler</caption>');
    expect(html).toContain('<caption class="sr-only">Görüşme sonuçları</caption>');
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Satış<\/th>/);
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Olumlu<\/th>/);
    for (const heading of ['Amaç', 'Birim', 'Miktar', 'Sonuç', 'Görüşme sayısı']) {
      expect(html).toContain(`<dt>${heading}</dt>`);
    }
    // Every first-row value is emitted by both the desktop table and mobile card.
    for (const value of ['Satış', 'Kutu', '12.500', 'Olumlu']) {
      expect((html.match(new RegExp(value, 'g')) ?? []).length).toBeGreaterThanOrEqual(2);
    }
    // The reused change-request reason label is context, not a stock metric:
    // the guard keeps forbidding stock metrics and allows exactly this label.
    expect(html.split('Stok veya ekipman eksik').join(''))
      .not.toMatch(/performans|puan|sıralama|ciro|stok|komisyon|Personelin bitirme zamanı|Mevcut plana göre zamanında|type="date"|select/i);
  });

  it('omits duplicated counters while preserving the current type distribution in a profile', () => {
    const html = renderToStaticMarkup(<StaffOperationalReport report={report} showCurrentWorkloadMetrics={false} />);
    expect(html).not.toContain('staff-current-workload-grid');
    expect(html).toContain('Mevcut iş yükünün tür dağılımı');
    expect(html).toContain('Seçilen dönem — yönetici onaylı sonuçlar');
    expect(html).toContain('Güncel sayaçlar sayfanın üstündeki Operasyon özeti bölümündedir.');
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
    expect(html).not.toContain('<caption class="sr-only">Onaylı teslimler</caption>');
    expect(html).toContain('<caption class="sr-only">Görüşme sonuçları</caption>');
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
      <MemoryRouter>
        <StaffOperationalReportScreen
          staffUserId={STAFF_ID}
          requestedRange={requestedRange}
        />
      </MemoryRouter>,
    ));
    await act(async () => { await Promise.resolve(); });

    expect(getStaffReport).toHaveBeenCalledWith(STAFF_ID, requestedRange);
    expect(container.querySelector('.page-header')).toBeTruthy();
  });

  it('loads management lateness incidents through the staff path', async () => {
    vi.mocked(getStaffReport).mockResolvedValue(report);
    vi.mocked(listStaffLatenessIncidents).mockResolvedValue({
      range: report.range, items: [], total: 0, limit: 20, offset: 0,
    });
    await act(async () => root.render(
      <MemoryRouter>
        <StaffOperationalReportScreen staffUserId={STAFF_ID} />
      </MemoryRouter>,
    ));
    await act(async () => { await Promise.resolve(); });

    const toggle = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Kayıtları göster')!;
    await act(async () => toggle.click());
    await act(async () => { await Promise.resolve(); });

    expect(listStaffLatenessIncidents).toHaveBeenCalledWith(
      STAFF_ID,
      null,
      { limit: 20, offset: 0 },
    );
    expect(listOwnLatenessIncidents).not.toHaveBeenCalled();
  });

  it('keeps the report mounted and the list open when "Yenile" reloads the same scope', async () => {
    const refreshed = { ...report, lateness: { ...report.lateness, generatedAt: '2026-07-31T12:05:00.000Z' } };
    vi.mocked(getStaffReport).mockResolvedValueOnce(report).mockResolvedValueOnce(refreshed);
    vi.mocked(listStaffLatenessIncidents).mockResolvedValue({
      range: report.range, items: [], total: 0, limit: 20, offset: 0,
    });
    await act(async () => root.render(
      <MemoryRouter>
        <StaffOperationalReportScreen staffUserId={STAFF_ID} />
      </MemoryRouter>,
    ));
    await act(async () => { await Promise.resolve(); });
    const button = (label: string) => Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === label);
    await act(async () => button('Kayıtları göster')!.click());
    await act(async () => { await Promise.resolve(); });
    const refresh = button('Yenile')!;

    await act(async () => refresh.click());
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    expect(getStaffReport).toHaveBeenCalledTimes(2);
    // Same element: the section was not unmounted behind a loading state.
    expect(button('Yenile')).toBe(refresh);
    expect(button('Kayıtları gizle')?.getAttribute('aria-expanded')).toBe('true');
    // The newer generatedAt reloads the open list's newest page.
    expect(listStaffLatenessIncidents).toHaveBeenCalledTimes(2);
    expect(vi.mocked(listStaffLatenessIncidents).mock.calls[1]).toEqual([
      STAFF_ID, null, { limit: 20, offset: 0 },
    ]);
  });

  it('loads the Staff self lateness incidents through the me path', async () => {
    vi.mocked(getOwnStaffReport).mockResolvedValue(report);
    vi.mocked(listOwnLatenessIncidents).mockResolvedValue({
      range: report.range, items: [], total: 0, limit: 20, offset: 0,
    });
    await act(async () => root.render(<StaffOperationalReportScreen />));
    await act(async () => { await Promise.resolve(); });

    const toggle = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Kayıtları göster')!;
    await act(async () => toggle.click());
    await act(async () => { await Promise.resolve(); });

    expect(listOwnLatenessIncidents).toHaveBeenCalledWith(null, { limit: 20, offset: 0 });
    expect(listStaffLatenessIncidents).not.toHaveBeenCalled();
  });

  it('keeps exactly one h1 on the management report route in every state', async () => {
    let resolveReport!: (value: StaffReportResponse) => void;
    vi.mocked(getStaffReport).mockReturnValue(new Promise((resolve) => { resolveReport = resolve; }));
    await renderWithRoute(root, `/staff/${STAFF_ID}/reports`,
      <StaffOperationalReportScreen staffUserId={STAFF_ID} />);
    expect(Array.from(container.querySelectorAll('h1')).map((heading) => heading.textContent))
      .toEqual(['Personel raporu']);

    await act(async () => resolveReport(report));
    expect(Array.from(container.querySelectorAll('h1')).map((heading) => heading.textContent))
      .toEqual(['Personel raporu']);
    expect(container.querySelector('.staff-report-identity h2')?.textContent).toBe('Emrah Demir');
  });

  it('keeps exactly one h1 when the management report fails', async () => {
    vi.mocked(getStaffReport).mockRejectedValue(new Error('Personel profili bulunamadı.'));
    await renderWithRoute(root, `/staff/${STAFF_ID}/reports`,
      <StaffOperationalReportScreen staffUserId={STAFF_ID} />);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(Array.from(container.querySelectorAll('h1')).map((heading) => heading.textContent))
      .toEqual(['Personel raporu']);
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
