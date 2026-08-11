/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StaffPerformanceReport } from '../src/reports/StaffPerformanceReport';
import { getStaffPerformance } from '../src/reports/reports-api';
import type { StaffPerformanceResponse } from '../src/reports/report-types';
import { ServoraAntProvider } from '../src/ui/antd';

vi.mock('../src/reports/reports-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/reports/reports-api')>(),
  getStaffPerformance: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn().mockReturnValue({
  matches: true, media: '(min-width: 64rem)', addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}) });
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

const range = { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' };
const priorRange = { from: '2026-05-31', to: '2026-06-30', timezone: 'Europe/Istanbul' };
const report: StaffPerformanceResponse = {
  range,
  priorRange,
  items: [
    {
      staff: { userId: '11111111-1111-4111-8111-111111111111', name: 'Ayşe Yılmaz', isActive: true },
      performance: { completedJobs: 42, completionDays: 18, jobsPerCompletionDay: 42 / 18,
        correctionRequestEvents: 1, authoredOperationalNotes: 17 },
      priorPerformance: {
        available: true,
        performance: { completedJobs: 34, completionDays: 17, jobsPerCompletionDay: 2,
          correctionRequestEvents: 2, authoredOperationalNotes: 12 },
      },
      staffExecution: { approvedJobsWithStaffCompletionTimestamp: 40,
        staffCompletionDays: 16, jobsPerStaffCompletionDay: 2.5,
        missingStaffCompletionTimestamp: 2 },
      onTime: { scheduledCompletedJobs: 10, onTimeCompletedJobs: 8,
        lateCompletedJobs: 2, unscheduledCompletedJobs: 32, onTimeRate: 0.8 },
      completionWorkTypes: [
        { type: 'SALES_MEETING', count: 14 },
        { type: 'PRODUCT_DELIVERY', count: 9 },
      ],
      currentWorkload: { openJobCards: 5, overdueJobCards: 1, waitingApproval: 2,
        revisionRequested: 0 },
    },
    {
      staff: { userId: '22222222-2222-4222-8222-222222222222', name: 'Mehmet Kaya', isActive: false },
      performance: { completedJobs: 0, completionDays: 0, jobsPerCompletionDay: 0,
        correctionRequestEvents: 3, authoredOperationalNotes: 12 },
      priorPerformance: { available: false, performance: null },
      staffExecution: { approvedJobsWithStaffCompletionTimestamp: 0,
        staffCompletionDays: 0, jobsPerStaffCompletionDay: 0,
        missingStaffCompletionTimestamp: 0 },
      onTime: { scheduledCompletedJobs: 0, onTimeCompletedJobs: 0,
        lateCompletedJobs: 0, unscheduledCompletedJobs: 0, onTimeRate: null },
      completionWorkTypes: [],
      currentWorkload: { openJobCards: 0, overdueJobCards: 0, waitingApproval: 0,
        revisionRequested: 0 },
    },
  ],
};

describe('StaffPerformanceReport', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(getStaffPerformance).mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(path = '/reports/staff?from=2026-07-01&to=2026-07-31') {
    await act(async () => root.render(
      <MemoryRouter initialEntries={[path]}>
        <ServoraAntProvider><StaffPerformanceReport /></ServoraAntProvider>
      </MemoryRouter>,
    ));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('renders historical comparison, expandable context, mobile records, and range-aware links', async () => {
    vi.mocked(getStaffPerformance).mockResolvedValue(report);
    await render();

    expect(getStaffPerformance).toHaveBeenCalledWith({
      from: '2026-07-01',
      to: '2026-07-31',
    });
    expect(container.querySelector('h1')?.textContent).toBe('Personel performansı');
    expect(container.textContent).toContain('Performans — 1 Temmuz 2026 – 31 Temmuz 2026');
    expect(container.textContent).toContain('Önceki dönem: 31 Mayıs 2026 – 30 Haziran 2026');
    expect(container.textContent).toContain('Önceki 34 · değişim +8');
    expect(container.textContent).toContain('Önceki dönem verisi yok');
    for (const label of [
      'Personel', 'Tamamlanan', 'Tamamlama günü', 'İş / gün',
      'Düzeltme isteği', 'Eklediği not',
    ]) expect(container.textContent).toContain(label);
    expect(container.querySelector('[data-staff-performance-desktop="true"]')).not.toBeNull();
    expect(container.querySelector('[data-staff-performance-mobile="true"]')).not.toBeNull();
    expect(container.querySelector('.servora-icon-segmented')?.getAttribute('aria-orientation'))
      .toBe('vertical');
    expect(container.textContent).toContain('Şu an');
    expect(container.textContent).toContain('Satış görüşmesi');
    expect(container.textContent).toContain('Ürün teslimi');
    expect(container.textContent).toContain('Personelin bitirme zamanı');
    expect(container.textContent).toContain('Mevcut plana göre zamanında');
    expect(container.textContent).toContain('8 / 10 zaman hedefli iş');
    expect(container.textContent).toContain('Zaman hedefli tamamlanan iş yok; oran hesaplanmadı.');
    const reportLinks = Array.from(container.querySelectorAll('a'))
      .filter((link) => link.textContent?.includes('Raporu aç'));
    expect(reportLinks[0]?.getAttribute('href')).toBe(
      '/staff/11111111-1111-4111-8111-111111111111/reports?from=2026-07-01&to=2026-07-31',
    );
    expect(container.textContent).not.toMatch(/puan|sıralama|liderlik|en iyi personel/i);

    const headers = Array.from(container.querySelectorAll('thead th'))
      .map((header) => header.textContent);
    expect(headers).not.toContain('Açık');
    expect(headers).not.toContain('Geciken');
    expect(headers).not.toContain('Zamanında');
  });

  it('filters staff without recomputing server metrics', async () => {
    vi.mocked(getStaffPerformance).mockResolvedValue(report);
    await render();
    const search = container.querySelector<HTMLInputElement>('input[name="staffSearch"]')!;

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        ?.set?.call(search, 'Mehmet');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.textContent).not.toContain('Ayşe Yılmaz');
    expect(container.textContent).toContain('Mehmet Kaya');
    expect(getStaffPerformance).toHaveBeenCalledTimes(1);
  });

  it('renders bounded loading, error/retry, and empty states', async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(getStaffPerformance).mockReturnValue(new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise;
    }));
    await render();
    expect(container.textContent).toContain('Personel performansı yükleniyor');

    await act(async () => reject(new Error('Rapor alınamadı.')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Rapor alınamadı.');
    vi.mocked(getStaffPerformance).mockResolvedValue({ ...report, items: [] });
    const retry = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Tekrar dene')!;
    await act(async () => retry.click());
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('Gösterilecek personel bulunmuyor');
  });
});
