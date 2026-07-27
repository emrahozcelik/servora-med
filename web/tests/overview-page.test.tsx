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
  recentCompletedWork: [{ id: 'j-1', title: 'Ürün teslimi', customerName: 'Klinik A', assigneeName: 'Ayşe Personel', completedAt: '2026-07-25' }],
  recentNotes: [{
    id: 'note-1', jobCardId: 'job-1', jobTitle: 'Klinik ziyareti',
    preview: 'Teslim saati klinikle doğrulandı.', authorName: 'Ayşe Personel',
    createdAt: '2026-07-25T10:00:00.000Z',
  }],
};

const managementOverview: OverviewResponse = {
  scope: 'management',
  range: { from: '2026-07-01', to: '2026-07-26' },
  active: 9, overdue: 2, waitingApproval: 3, revisionRequested: 1,
  completedInPeriod: 6, cancelledInPeriod: 1,
  completionTrend: [{ date: '2026-07-25', count: 2 }],
  approvalQueueSummary: { pendingCount: 3, oldestWaitingMinutes: 120 },
  recentCompletedWork: [{ id: 'j-2', title: 'Muayene ziyareti', customerName: 'Klinik B', assigneeName: 'Ahmet Yönetici', completedAt: '2026-07-24' }],
  recentNotes: [{
    id: 'note-2', jobCardId: 'job-2', jobTitle: 'Toplantı',
    preview: 'Haftalık değerlendirme yapıldı.', authorName: 'Ahmet Yönetici',
    createdAt: '2026-07-24T14:00:00.000Z',
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

async function renderError(message: string) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter><RealtimeProvider>
      <OverviewPage user={user} load={vi.fn().mockRejectedValue(new Error(message))} />
    </RealtimeProvider></MemoryRouter>);
  });
  await act(async () => { await Promise.resolve(); });
  const html = container.innerHTML;
  await act(async () => root.unmount());
  return html;
}

describe('OverviewPage', () => {
  it('renders LoadingSkeleton while loading', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(<MemoryRouter><RealtimeProvider>
        <OverviewPage user={user} load={() => new Promise(() => {})} />
      </RealtimeProvider></MemoryRouter>);
    });
    const html = container.innerHTML;
    expect(html).toContain('Genel bakış yükleniyor…');
    await act(async () => root.unmount());
  });

  it('renders ResultState on error with retry button', async () => {
    const html = await renderError('Bağlantı kurulamadı.');
    expect(html).toContain('Genel bakış yüklenemedi');
    expect(html).toContain('Bağlantı kurulamadı.');
    expect(html).toContain('Tekrar dene');
  });

  it('renders MetricStatistic KPI cards for staff scope', async () => {
    const html = await render(staffOverview);
    expect(html).toContain('Açık işler');
    expect(html).toContain('Kontrol bekleyen');
    expect(html).toContain('Düzeltme gereken');
    expect(html).toContain('Tamamlanan');
    expect(html).not.toContain('Geciken');
    expect(html).not.toContain('Aktif işler');
  });

  it('renders MetricStatistic KPI cards for management scope', async () => {
    const html = await render(managementOverview);
    expect(html).toContain('Aktif işler');
    expect(html).toContain('Geciken');
    expect(html).toContain('Kontrol bekleyen');
    expect(html).not.toContain('Açık işler');
  });

  it('renders management trend and approval summary only for management scope', async () => {
    const html = await render(managementOverview);
    expect(html).toContain('Tamamlanma eğilimi');
    expect(html).toContain('Kontrol kuyruğunda');
    expect(html).toContain('3 iş');

    const staffHtml = await render(staffOverview);
    expect(staffHtml).not.toContain('Tamamlanma eğilimi');
    expect(staffHtml).not.toContain('Kontrol kuyruğunda');
  });

  it('renders OperationalCards for recent completed work', async () => {
    const html = await render(staffOverview);
    expect(html).toContain('Ürün teslimi');
    expect(html).toContain('Klinik A');
    expect(html).toContain('Ayşe Personel');
  });

  it('renders OperationalCards for recent notes', async () => {
    const html = await render(staffOverview);
    expect(html).toContain('Teslim saati klinikle doğrulandı.');
    expect(html).toContain('Ayşe Personel');
  });

  it('renders EmptyState when recent completed work is empty', async () => {
    const html = await render({ ...staffOverview, recentCompletedWork: [] });
    expect(html).toContain('Bu dönemde tamamlanan iş bulunmuyor');
  });

  it('renders EmptyState when recent notes are empty', async () => {
    const html = await render({ ...staffOverview, recentNotes: [] });
    expect(html).toContain('Yakın tarihli not bulunmuyor');
  });

  it('renders EmptyState when upcoming work is empty', async () => {
    const html = await render({
      ...staffOverview,
      upcomingWork: { items: [], window: { from: '2026-07-27', to: '2026-08-03' } },
    });
    expect(html).toContain('Yaklaşan iş bulunmuyor');
  });

  it('renders OperationalCards for upcoming work', async () => {
    const html = await render({
      ...staffOverview,
      upcomingWork: {
        items: [{ id: 'u-1', source: 'JOB' as const, title: 'Planlı ziyaret', startsAt: '2026-07-28T09:00:00.000Z', endsAt: null, assignedUserName: 'Ayşe Personel', path: '/jobs/u-1' }],
        window: { from: '2026-07-27', to: '2026-08-03' },
      },
    });
    expect(html).toContain('Planlı ziyaret');
    expect(html).toContain('Ayşe Personel');
  });
});
