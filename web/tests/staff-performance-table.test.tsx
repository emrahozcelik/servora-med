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
    completedJobs: 42, authoredOperationalNotes: 17,
    staffSubmissionAttribution: { recordedSubmissionCount: 6, recordedSubmissionDays: 4 },
    priorRangeLabel: '31 Mayıs 2026 – 30 Haziran 2026',
    priorPerformance: { available: true, performance: { completedJobs: 34,
      authoredOperationalNotes: 12 } },
    completionWorkTypes: [
      { label: 'Satış görüşmesi', count: 14 },
      { label: 'Ürün teslimi', count: 9 },
      { label: 'Genel görev', count: 0 },
    ],
    currentWorkloadByType: [
      { label: 'Ürün teslimi', count: 2 },
      { label: 'Genel görev', count: 2 },
      { label: 'Satış görüşmesi', count: 1 },
    ],
    currentWorkload: { openJobCards: 5, overdueJobCards: 1, waitingApproval: 2,
      revisionRequested: 0 },
    reportHref: '/staff/ayse/reports?from=2026-07-01&to=2026-07-31',
  },
  {
    key: 'mehmet', name: 'Mehmet Kaya', isActive: false,
    completedJobs: 0, authoredOperationalNotes: 12,
    staffSubmissionAttribution: { recordedSubmissionCount: 0, recordedSubmissionDays: 0 },
    priorRangeLabel: '31 Mayıs 2026 – 30 Haziran 2026',
    priorPerformance: { available: false, performance: null },
    completionWorkTypes: [
      { label: 'Satış görüşmesi', count: 0 },
      { label: 'Ürün teslimi', count: 0 },
      { label: 'Genel görev', count: 0 },
    ],
    currentWorkloadByType: [
      { label: 'Ürün teslimi', count: 0 },
      { label: 'Genel görev', count: 0 },
      { label: 'Satış görüşmesi', count: 0 },
    ],
    currentWorkload: { openJobCards: 0, overdueJobCards: 0, waitingApproval: 0,
      revisionRequested: 0 },
    reportHref: '/staff/mehmet/reports?from=2026-07-01&to=2026-07-31',
  },
];

describe('StaffPerformanceTable adapter', () => {
  it('provides grouped operational headers, keyboard-native expansion, and mobile records', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(
      <MemoryRouter>
        <ServoraAntProvider><StaffPerformanceTable records={records} /></ServoraAntProvider>
      </MemoryRouter>,
    ));

    const completedHeader = Array.from(container.querySelectorAll('thead th'))
      .find((header) => header.textContent?.includes('Yönetici onaylı tamamlananlar'))!;
    const sortButton = completedHeader.querySelector<HTMLButtonElement>('button')!;
    expect(sortButton.tabIndex).toBe(0);
    expect(sortButton.getAttribute('aria-label')).toContain('Yönetici onaylı tamamlananlar sütununu sırala');
    expect(container.textContent).toContain('ŞU AN');
    expect(container.textContent).toContain('SEÇİLEN DÖNEM');
    await act(async () => sortButton.click());
    expect(completedHeader.getAttribute('aria-sort')).toBe('ascending');
    expect(container.querySelector('tbody tr[data-row-key]')?.textContent).toContain('Mehmet Kaya');

    const expand = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Ayşe Yılmaz ayrıntılarını göster"]',
    )!;
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    await act(async () => expand.click());
    expect(container.textContent).toContain('Satış görüşmesi');
    expect(container.textContent).toContain('Aksiyon alınabilir');
    expect(container.textContent).toContain('Mevcut iş yükünün tür dağılımı');
    expect(container.textContent).toContain('Onaya gönderme kaydı');
    expect(container.querySelector('button[aria-label="Ayşe Yılmaz ayrıntılarını gizle"]'))
      .not.toBeNull();

    const mobile = container.querySelector('[data-staff-performance-mobile="true"]')!;
    expect(mobile.querySelectorAll('li.staff-performance-mobile-record')).toHaveLength(2);
    expect(mobile.querySelector('details summary')?.textContent).toContain('Ayrıntıları göster');
    expect(mobile.querySelector('a')?.getAttribute('href')).toContain('from=2026-07-01');
    expect(Array.from(container.querySelectorAll('thead th')).map((header) => header.textContent))
      .not.toContain('İş / gün');

    await act(async () => root.unmount());
    container.remove();
  });
});
