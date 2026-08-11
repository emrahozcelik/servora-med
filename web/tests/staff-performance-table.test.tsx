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
    jobsPerCompletionDayLabel: '2,3', correctionRequestEvents: 1,
    authoredOperationalNotes: 17,
    workTypes: [{ label: 'Satış görüşmesi', count: 14 }],
    currentWorkload: { openJobCards: 5, overdueJobCards: 1, waitingApproval: 2,
      revisionRequested: 0 },
    reportHref: '/staff/ayse/reports?from=2026-07-01&to=2026-07-31',
  },
  {
    key: 'mehmet', name: 'Mehmet Kaya', isActive: false,
    completedJobs: 0, completionDays: 0, jobsPerCompletionDay: 0,
    jobsPerCompletionDayLabel: '0', correctionRequestEvents: 3,
    authoredOperationalNotes: 12, workTypes: [],
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
    expect(container.querySelector('button[aria-label="Ayşe Yılmaz ayrıntılarını gizle"]'))
      .not.toBeNull();

    const mobile = container.querySelector('[data-staff-performance-mobile="true"]')!;
    expect(mobile.querySelectorAll('li.staff-performance-mobile-record')).toHaveLength(2);
    expect(mobile.querySelector('details summary')?.textContent).toContain('Ayrıntıları göster');
    expect(mobile.querySelector('a')?.getAttribute('href')).toContain('from=2026-07-01');

    await act(async () => root.unmount());
    container.remove();
  });
});
