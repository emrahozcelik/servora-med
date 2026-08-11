/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import {
  ServoraAntProvider,
  StaffPerformanceTable,
  type StaffPerformanceTableRecord,
} from '../src/ui/antd';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn().mockReturnValue({
  matches: false, media: '(min-width: 64rem)', addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}) });
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

const records: StaffPerformanceTableRecord[] = [
  {
    key: 'ayse', name: 'Ayşe Yılmaz', isActive: true,
    completedJobs: 42, completionDays: 18, jobsPerCompletionDay: 2.333,
    correctionRequestEvents: 1, authoredOperationalNotes: 17,
    priorRangeLabel: '31 Mayıs 2026 – 30 Haziran 2026',
    priorPerformance: { available: true, performance: { completedJobs: 34,
      completionDays: 17, jobsPerCompletionDay: 3, correctionRequestEvents: 2,
      authoredOperationalNotes: 12 } },
    staffExecution: { approvedJobsWithStaffCompletionTimestamp: 40,
      staffCompletionDays: 16, jobsPerStaffCompletionDay: 2.5,
      missingStaffCompletionTimestamp: 2 },
    onTime: { scheduledCompletedJobs: 10, onTimeCompletedJobs: 8,
      lateCompletedJobs: 2, unscheduledCompletedJobs: 32, onTimeRate: 0.8 },
    workTypes: [{ label: 'Satış görüşmesi', count: 14 }],
    currentWorkload: { openJobCards: 5, overdueJobCards: 1, waitingApproval: 2,
      revisionRequested: 0 },
    reportHref: '/staff/ayse/reports?from=2026-07-01&to=2026-07-31',
  },
  {
    key: 'mehmet', name: 'Mehmet Kaya', isActive: false,
    completedJobs: 0, completionDays: 0, jobsPerCompletionDay: 0,
    correctionRequestEvents: 3, authoredOperationalNotes: 12,
    priorRangeLabel: '31 Mayıs 2026 – 30 Haziran 2026',
    priorPerformance: { available: false, performance: null },
    staffExecution: { approvedJobsWithStaffCompletionTimestamp: 0,
      staffCompletionDays: 0, jobsPerStaffCompletionDay: 0,
      missingStaffCompletionTimestamp: 0 },
    onTime: { scheduledCompletedJobs: 0, onTimeCompletedJobs: 0,
      lateCompletedJobs: 0, unscheduledCompletedJobs: 0, onTimeRate: null },
    workTypes: [],
    currentWorkload: { openJobCards: 0, overdueJobCards: 0, waitingApproval: 0,
      revisionRequested: 0 },
    reportHref: '/staff/mehmet/reports?from=2026-07-01&to=2026-07-31',
  },
];

describe('StaffPerformanceTable adapter', () => {
  it('provides keyboard-sortable headers, keyboard-native expansion, and mobile records', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(
      <MemoryRouter>
        <ServoraAntProvider><StaffPerformanceTable records={records} /></ServoraAntProvider>
      </MemoryRouter>,
    ));

    const completedHeader = Array.from(container.querySelectorAll('thead th'))
      .find((header) => header.textContent?.includes('Tamamlanan'))!;
    const sortButton = completedHeader.querySelector<HTMLButtonElement>('button')!;
    expect(sortButton.tabIndex).toBe(0);
    expect(sortButton.getAttribute('aria-label')).toContain('Tamamlanan sütununu sırala');
    expect(container.textContent).toContain('Önceki 34 · değişim +8');
    expect(container.textContent).toContain('Önceki 3 · değişim -0,7');
    await act(async () => sortButton.click());
    expect(completedHeader.getAttribute('aria-sort')).toBe('ascending');
    expect(container.querySelector('tbody tr[data-row-key]')?.textContent).toContain('Mehmet Kaya');

    const expand = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Ayşe Yılmaz ayrıntılarını göster"]',
    )!;
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    await act(async () => expand.click());
    expect(container.textContent).toContain('Satış görüşmesi');
    expect(container.textContent).toContain('5 açık');
    expect(container.textContent).toContain('Personelin bitirme zamanı');
    expect(container.textContent).toContain('2 onaylı işte bu zaman eksik');
    expect(container.textContent).toContain('8 / 10 zaman hedefli iş');
    expect(container.textContent).toContain('32 tamamlanan işte zaman hedefi yok');
    expect(container.querySelector('button[aria-label="Ayşe Yılmaz ayrıntılarını gizle"]'))
      .not.toBeNull();

    const mobile = container.querySelector('[data-staff-performance-mobile="true"]')!;
    expect(mobile.querySelectorAll('li.staff-performance-mobile-record')).toHaveLength(2);
    expect(mobile.querySelector('details summary')?.textContent).toContain('Ayrıntıları göster');
    expect(mobile.querySelector('a')?.getAttribute('href')).toContain('from=2026-07-01');
    expect(Array.from(container.querySelectorAll('thead th')).map((header) => header.textContent))
      .not.toContain('Zamanında');

    await act(async () => root.unmount());
    container.remove();
  });
});
