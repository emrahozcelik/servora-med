/**
 * Rendered fixture for the login and overview surfaces (UI audit F-16/F-17).
 *
 * Real production components, providers and CSS with deterministic synthetic
 * medical/dental data. No server, no database and no live API: the overview
 * list endpoints that would otherwise run are answered with an empty page at
 * the fetch boundary.
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../src/App';
import { OverviewPage } from '../src/overview/OverviewPage';
import { PasswordChangeScreen } from '../src/PasswordChange';
import { RealtimeProvider } from '../src/realtime/RealtimeProvider';
import type { CurrentUser } from '../src/services/api';
import type { OverviewResponse } from '../src/services/overview-api';
import { ServoraAntProvider } from '../src/ui/antd';
import '../src/styles.css';

export const managerUser: CurrentUser = {
  id: 'user-manager-1',
  organizationId: 'org-1',
  name: 'Ahmet Yönetici',
  email: 'ahmet.yonetici@ornek-klinik.example',
  role: 'MANAGER',
  mustChangePassword: false,
  isActive: true,
  version: 4,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

function trend(days: number): Array<{ date: string; count: number }> {
  // Fixed period: 2026-10-21 .. 2026-11-19 (30 days), with ordinary zero days
  // so the baseline tick is part of the captured evidence.
  const counts = [0, 2, 1, 0, 0, 3, 2, 1, 0, 4, 2, 0, 1, 1, 0, 2, 3, 1, 0, 0, 2, 1, 4, 2, 0, 1, 0, 3, 2, 1];
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(2026, 9, 21 + index));
    return { date: date.toISOString().slice(0, 10), count: counts[index] ?? 0 };
  });
}

export function buildOverview(unreadTotal: number): OverviewResponse {
  return {
    scope: 'management',
    range: { from: '2026-10-21', to: '2026-11-19', timezone: 'Europe/Istanbul' },
    generatedAt: '2026-11-19T08:15:00.000Z',
    active: 14,
    overdue: 3,
    waitingApproval: 3,
    revisionRequested: 2,
    completedInPeriod: 38,
    cancelledInPeriod: 2,
    completionTrend: trend(30),
    approvalQueueSummary: { pendingCount: 3, oldestWaitingMinutes: 135 },
    workTypeDistribution: [
      { type: 'SALES_MEETING', count: 6 },
      { type: 'PRODUCT_DELIVERY', count: 4 },
      { type: 'GENERAL_TASK', count: 3 },
    ],
    recentCompletedWork: [
      { id: 'job-1021', title: 'Dental implant seti teslimi', customerName: 'Mavi Klinik', assigneeName: 'Elif Saha', completedAt: '2026-11-18T12:40:00.000Z' },
      { id: 'job-1018', title: 'Ortodonti braket kontrolü', customerName: 'Deniz Ağız Sağlığı', assigneeName: 'Mert Saha', completedAt: '2026-11-18T09:05:00.000Z' },
      { id: 'job-1012', title: 'Yeni ürün tanıtım ziyareti', customerName: 'Yıldız Diş Polikliniği', assigneeName: 'Elif Saha', completedAt: '2026-11-17T15:20:00.000Z' },
    ],
    recentNotes: [
      { id: 'note-1', jobCardId: 'job-1024', jobTitle: 'Sterilizasyon cihazı kurulumu', authorName: 'Elif Saha', createdAt: '2026-11-19T06:10:00.000Z' },
      { id: 'note-2', jobCardId: 'job-1021', jobTitle: 'Dental implant seti teslimi', authorName: 'Mert Saha', createdAt: '2026-11-18T17:35:00.000Z' },
      { id: 'note-3', jobCardId: 'job-1018', jobTitle: 'Ortodonti braket kontrolü', authorName: 'Ahmet Yönetici', createdAt: '2026-11-18T11:00:00.000Z' },
    ],
    upcomingWork: {
      items: [
        { id: 'job-1031', source: 'JOB', title: 'Haftalık klinik ziyareti', startsAt: '2026-11-20T06:30:00.000Z', endsAt: null, assignedUserName: 'Elif Saha', path: '/jobs/job-1031' },
        { id: 'event-7', source: 'MANUAL', title: 'Bölge satış toplantısı', startsAt: '2026-11-21T11:00:00.000Z', endsAt: null, assignedUserName: 'Ahmet Yönetici', path: '/calendar' },
      ],
      window: { from: '2026-11-20', to: '2026-11-27' },
    },
    messageUnreadSummary: { unreadTotal },
  };
}

function stubOverviewListFetch() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url.includes('/api/job-cards/submission-late/open')
      || url.includes('/api/job-cards/pending-acceptance/past-start')) {
      return Promise.resolve(new Response(
        JSON.stringify({ items: [], total: 0, limit: 20, offset: 0 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    }
    return originalFetch(input, init);
  };
}

const params = new URLSearchParams(window.location.search);
const surface = params.get('surface');
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('fixture root missing');

if (surface === 'password-change') {
  createRoot(rootElement).render(
    <ServoraAntProvider>
      <MemoryRouter initialEntries={['/change-password']}>
        <PasswordChangeScreen
          user={managerUser}
          onChanged={() => {}}
          onSignedOut={() => {}}
        />
      </MemoryRouter>
    </ServoraAntProvider>,
  );
} else if (surface === 'overview') {
  stubOverviewListFetch();
  const unreadTotal = Number(params.get('unread') ?? '0');
  createRoot(rootElement).render(
    <ServoraAntProvider>
      <MemoryRouter initialEntries={['/overview']}>
        <RealtimeProvider eventSourceFactory={() => null}>
          <OverviewPage user={managerUser} load={async () => buildOverview(unreadTotal)} />
        </RealtimeProvider>
      </MemoryRouter>
    </ServoraAntProvider>,
  );
} else {
  createRoot(rootElement).render(
    <ServoraAntProvider>
      <MemoryRouter initialEntries={['/login']}>
        <App initialUser={null} />
      </MemoryRouter>
    </ServoraAntProvider>,
  );
}
