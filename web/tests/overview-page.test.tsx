/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { OverviewPage } from '../src/overview/OverviewPage';
import { RealtimeProvider } from '../src/realtime/RealtimeProvider';
import type { CurrentUser } from '../src/services/api';
import type { OverviewResponse } from '../src/services/overview-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const user: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel',
  email: 'staff@example.com', role: 'STAFF', mustChangePassword: false,
  isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: false, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

const staffOverview: OverviewResponse = {
  scope: 'staff',
  range: { from: '2026-07-01', to: '2026-07-26' },
  openJobCards: 4,
  waitingApproval: 2,
  revisionRequested: 1,
  completedInPeriod: 7,
  recentCompletedWork: [],
  recentNotes: [{
    id: 'note-1', jobCardId: 'job-1', jobTitle: 'Klinik ziyareti',
    preview: 'Teslim saati klinikle doğrulandı.', authorName: 'Ayşe Personel',
    createdAt: '2026-07-25T10:00:00.000Z',
  }],
};

async function render(overview: OverviewResponse) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter><RealtimeProvider>
      <OverviewPage user={user} load={vi.fn().mockResolvedValue(overview)} />
    </RealtimeProvider></MemoryRouter>);
  });
  await act(async () => { await Promise.resolve(); });
  const html = container.innerHTML;
  await act(async () => root.unmount());
  return html;
}

describe('OverviewPage', () => {
  it('renders only staff-scoped counters and scoped note previews for staff', async () => {
    const html = await render(staffOverview);
    expect(html).toContain('Açık işler');
    expect(html).toContain('Teslim saati klinikle doğrulandı.');
    expect(html).not.toContain('Geciken');
    expect(html).not.toContain('Kontrol kuyruğunda');
  });

  it('renders management trend and approval summary only for management scope', async () => {
    const management: OverviewResponse = {
      scope: 'management',
      range: staffOverview.range,
      active: 9, overdue: 2, waitingApproval: 3, revisionRequested: 1,
      completedInPeriod: 6, cancelledInPeriod: 1,
      completionTrend: [{ date: '2026-07-25', count: 2 }],
      approvalQueueSummary: { pendingCount: 3, oldestWaitingMinutes: 120 },
      recentCompletedWork: [], recentNotes: [],
    };
    const html = await render(management);
    expect(html).toContain('Tamamlanma eğilimi');
    expect(html).toContain('Kontrol kuyruğunda 3 iş');
    expect(html).not.toContain('Açık işler');
  });

  it('shows explicit empty and error states without stale recent content', async () => {
    const empty = await render({ ...staffOverview, recentNotes: [] });
    expect(empty).toContain('Bu dönemde tamamlanan iş bulunmuyor.');
    expect(empty).toContain('Yetki kapsamınızda yakın tarihli not bulunmuyor.');

    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(<MemoryRouter><RealtimeProvider>
        <OverviewPage user={user} load={vi.fn().mockRejectedValue(new Error('Bağlantı kurulamadı.'))} />
      </RealtimeProvider></MemoryRouter>);
    });
    await act(async () => { await Promise.resolve(); });
    expect(container.innerHTML).toContain('Genel bakış yüklenemedi');
    expect(container.innerHTML).toContain('Tekrar dene');
    expect(container.innerHTML).not.toContain('Teslim saati');
    await act(async () => root.unmount());
  });
});
