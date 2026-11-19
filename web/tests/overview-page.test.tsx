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
  range: { from: '2026-07-01', to: '2026-07-26', timezone: 'Europe/Istanbul' },
  openJobCards: 4,
  waitingApproval: 2,
  revisionRequested: 1,
  completedInPeriod: 7,
  recentCompletedWork: [{ id: 'j-1', title: 'Ürün teslimi', customerName: 'Klinik A', assigneeName: 'Ayşe Personel', completedAt: '2026-07-25' }],
  recentNotes: [{
    id: 'note-1', jobCardId: 'job-1', jobTitle: 'Klinik ziyareti',
    authorName: 'Ayşe Personel',
    createdAt: '2026-07-25T10:00:00.000Z',
  }],
};

const managementOverview: OverviewResponse = {
  scope: 'management',
  range: { from: '2026-07-01', to: '2026-07-26', timezone: 'Europe/Istanbul' },
  active: 9, overdue: 2, waitingApproval: 3, revisionRequested: 1,
  completedInPeriod: 6, cancelledInPeriod: 1,
  completionTrend: [{ date: '2026-07-25', count: 2 }],
  approvalQueueSummary: { pendingCount: 3, oldestWaitingMinutes: 120 },
  workTypeDistribution: [
    { type: 'GENERAL_TASK', count: 2 },
    { type: 'WEEKLY_REPORT', count: 1 },
  ],
  recentCompletedWork: [{ id: 'j-2', title: 'Muayene ziyareti', customerName: 'Klinik B', assigneeName: 'Ahmet Yönetici', completedAt: '2026-07-24' }],
  recentNotes: [{
    id: 'note-2', jobCardId: 'job-2', jobTitle: 'Toplantı',
    authorName: 'Ahmet Yönetici',
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

  it('links the Geciken KPI to the server-owned overdue query, not the range end', async () => {
    const html = await render(managementOverview);
    expect(html).toContain('/jobs?overdue=true');
    expect(html).not.toContain('dueBefore=2026-07-26');
  });

  it('renders the manager approval queue with its oldest wait and no duplicate trend sentence', async () => {
    const html = await render(managementOverview);
    expect(html).toContain('Onay kuyruğu');
    expect(html).toContain('3</strong> iş onay bekliyor');
    expect(html).toContain('En eskisi 2 sa 0 dk bekliyor.');
    expect(html).toContain('href="/reports/approvals"');
    expect(html).toContain('Tamamlanma eğilimi');
    expect(html).not.toContain('Kontrol kuyruğunda');

    const staffHtml = await render(staffOverview);
    expect(staffHtml).not.toContain('Tamamlanma eğilimi');
    expect(staffHtml).not.toContain('Onay kuyruğu');
  });

  it('keeps the approval queue null-safe and calm when nothing waits', async () => {
    const neverMeasured = await render({
      ...managementOverview,
      approvalQueueSummary: { pendingCount: 2, oldestWaitingMinutes: null },
    });
    expect(neverMeasured).toContain('En eski bekleme süresi henüz ölçülmedi.');
    expect(neverMeasured).not.toContain('null');

    const empty = await render({
      ...managementOverview,
      waitingApproval: 0,
      approvalQueueSummary: { pendingCount: 0, oldestWaitingMinutes: null },
    });
    expect(empty).toContain('Kontrol bekleyen iş yok.');
    expect(empty).not.toContain('iş onay bekliyor');
  });

  it('renders OperationalCards for recent completed work', async () => {
    const html = await render(staffOverview);
    expect(html).toContain('Ürün teslimi');
    expect(html).toContain('Klinik A');
    expect(html).toContain('Ayşe Personel');
  });

  it('renders canonical Turkish work-type labels without raw enums', async () => {
    const html = await render(managementOverview);
    expect(html).toContain('İş dağılımı');
    expect(html).toContain('Genel görev');
    expect(html).toContain('Haftalık rapor');
    expect(html).not.toContain('WEEKLY_REPORT');
    expect(html).not.toContain('GENERAL_TASK');
  });

  it('keeps two semantic overview columns and a single work-distribution card', async () => {
    const html = await render(managementOverview);
    expect((html.match(/class="overview-main-column"/g) ?? []).length).toBe(2);
    expect(html).toContain('overview-distribution-list');
    expect(html).toContain('2 iş · %67');
    expect(html).toContain('1 iş · %33');
    expect(html).not.toContain('zamanında tamamlanma');
  });

  it('adds readable second-channel phrases to colored metrics', async () => {
    const html = await render(managementOverview);
    expect(html).toContain('Termin süresi aşıldı');
    expect(html).toContain('Düzeltme bekleyen kayıtlar');
    expect(html).toContain('Yönetici değerlendirmesinde');
    expect(html).not.toContain('Europe/Istanbul');
  });

  it('resets zero-count KPI tones and omits the unread-message section at zero', async () => {
    const html = await render({
      ...managementOverview,
      overdue: 0,
      waitingApproval: 0,
      revisionRequested: 0,
      messageUnreadSummary: { unreadTotal: 0 },
    });
    expect(html).toContain('Geciken iş yok');
    expect(html).toContain('Bekleyen onay yok');
    expect(html).toContain('Düzeltme bekleyen iş yok');
    expect(html).not.toContain('Termin süresi aşıldı');
    expect(html).not.toContain('servora-metric-statistic--overdue');
    expect(html).not.toContain('servora-metric-statistic--warning');
    // The notification bell already covers an empty inbox.
    expect(html).not.toContain('Okunmamış mesaj');
    expect(html).not.toContain('Tüm operasyon mesajları okundu');
    expect(html).not.toContain('Yeni operasyon mesajı');
  });

  it('shows the unread-message section only while messages are unread', async () => {
    const html = await render({
      ...managementOverview,
      messageUnreadSummary: { unreadTotal: 3 },
    });
    expect(html).toContain('Okunmamış mesaj');
    expect(html).toContain('3 okunmamış mesaj');
    expect(html).toContain('href="/messages"');
  });

  it('keeps lateness as the strongest KPI tone and approval waiting neutral', async () => {
    const html = await render(managementOverview);
    expect((html.match(/servora-metric-statistic--overdue/g) ?? []).length).toBe(1);
    expect((html.match(/servora-metric-statistic--warning/g) ?? []).length).toBe(1);
    expect(html).not.toContain('servora-metric-statistic--attention');
    expect(html).toContain('Yönetici değerlendirmesinde');
  });

  it('renders record timestamps without seconds and with a readable shape', async () => {
    const html = await render(managementOverview);
    expect(html).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
    expect(html).toContain('Cum 24 Tem · 17:00');
    expect(html).toContain('Gösterilen aralık: ');

    const staffHtml = await render(staffOverview);
    expect(staffHtml).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
    expect(staffHtml).toContain('Cmt 25 Tem · 13:00');
  });

  it('renders notes as author, time and job title without filler copy', async () => {
    const html = await render(staffOverview);
    expect(html).not.toContain('Operasyon notu eklendi');
    expect(html).not.toContain('Teslim saati klinikle doğrulandı.');
    expect(html).toContain('Klinik ziyareti');
    expect(html).toContain('Ayşe Personel · Cmt 25 Tem · 13:00');
    expect(html).toContain('overview-row-list');
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
