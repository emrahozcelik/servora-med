import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from '../src/App';
import type { CurrentUser } from '../src/services/api';
import '../src/styles.css';

declare global {
  interface Window {
    __evidenceRequests: string[];
    __evidenceUnexpectedRequests: string[];
  }
}

const query = new URLSearchParams(window.location.search);
const requestedRole = query.get('role');
const role = requestedRole === 'manager'
  ? 'MANAGER'
  : requestedRole === 'admin'
    ? 'ADMIN'
    : 'STAFF';
const overviewDashboard = query.get('overview') !== 'off';
const emptyOverview = query.get('empty') === '1';
const errorOverview = query.get('error') === '1';

const identities = {
  STAFF: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Ayşe Sentetik Uzunsoy',
    email: 'ayse.sentetik.uzunsoy@example.test',
  },
  MANAGER: {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Murat Sentetik Yönetici',
    email: 'murat.yonetici@example.test',
  },
  ADMIN: {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Deniz Sentetik Admin',
    email: 'deniz.admin@example.test',
  },
} as const;

const identity = identities[role];
const user: CurrentUser = {
  ...identity,
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role,
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: {
    overviewDashboard,
    calendar: false,
    messaging: false,
  },
  support: {
    displayLabel: 'Sentetik operasyon desteği',
    email: 'support@example.test',
    helpUrl: 'https://support.example.test/servora',
  },
};

const recentCompletedWork = [
  {
    id: '44444444-4444-4444-8444-444444444444',
    title: 'Merkez Klinik ürün teslimi',
    customerName: 'Merkez Sentetik Klinik',
    assigneeName: role === 'STAFF' ? identity.name : 'Selin Sentetik',
    completedAt: '2026-07-25T12:30:00.000Z',
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    title: 'Yeni ürün bilgilendirme ziyareti',
    customerName: 'Örnek Ağız Sağlığı Merkezi',
    assigneeName: role === 'STAFF' ? identity.name : 'Can Sentetik',
    completedAt: '2026-07-24T09:15:00.000Z',
  },
];
const recentNotes = [
  {
    id: '66666666-6666-4666-8666-666666666666',
    jobCardId: recentCompletedWork[0].id,
    jobTitle: recentCompletedWork[0].title,
    preview: 'Teslim saati klinik yetkilisiyle doğrulandı; kayıt yönetici kontrolüne hazır.',
    authorName: role === 'STAFF' ? identity.name : 'Selin Sentetik',
    createdAt: '2026-07-25T11:45:00.000Z',
  },
  {
    id: '77777777-7777-4777-8777-777777777777',
    jobCardId: recentCompletedWork[1].id,
    jobTitle: recentCompletedWork[1].title,
    preview: 'Takip görüşmesi için ürün kataloğundaki mevcut bilgiler gözden geçirildi.',
    authorName: role === 'STAFF' ? identity.name : 'Can Sentetik',
    createdAt: '2026-07-24T08:30:00.000Z',
  },
];

const overview = role === 'STAFF'
  ? {
      scope: 'staff',
      range: { from: '2026-07-01', to: '2026-07-26', timezone: 'Europe/Istanbul' },
      generatedAt: '2026-07-26T08:00:00.000Z',
      openJobCards: 6,
      waitingApproval: 2,
      revisionRequested: 1,
      completedInPeriod: 9,
      recentCompletedWork: emptyOverview ? [] : recentCompletedWork,
      recentNotes: emptyOverview ? [] : recentNotes,
    }
  : {
      scope: 'management',
      range: { from: '2026-07-01', to: '2026-07-26', timezone: 'Europe/Istanbul' },
      generatedAt: '2026-07-26T08:00:00.000Z',
      active: 24,
      overdue: 3,
      waitingApproval: 5,
      revisionRequested: 2,
      completedInPeriod: 31,
      cancelledInPeriod: 2,
      completionTrend: [
        { date: '2026-07-21', count: 4 },
        { date: '2026-07-22', count: 7 },
        { date: '2026-07-23', count: 5 },
        { date: '2026-07-24', count: 8 },
        { date: '2026-07-25', count: 7 },
      ],
      approvalQueueSummary: { pendingCount: 5, oldestWaitingMinutes: 135 },
      recentCompletedWork: emptyOverview ? [] : recentCompletedWork,
      recentNotes: emptyOverview ? [] : recentNotes,
    };

window.__evidenceRequests = [];
window.__evidenceUnexpectedRequests = [];
Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), window.location.origin);
    window.__evidenceRequests.push(`${url.pathname}${url.search}`);
    if (url.pathname === '/api/overview') {
      if (errorOverview) {
        return new Response(JSON.stringify({ code: 'EVIDENCE_FIXTURE_ERROR', error: 'Sentetik genel bakış hatası.' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(overview), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/notifications/unread-count') {
      return new Response(JSON.stringify({ unreadCount: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/web-push/status') {
      return new Response(JSON.stringify({
        enabled: false, vapidPublicKey: null, renewalRequired: false, subscription: null,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/job-cards') {
      return new Response(JSON.stringify({ items: [], total: 0, limit: 25, offset: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    window.__evidenceUnexpectedRequests.push(`${url.pathname}${url.search}`);
    return new Response(JSON.stringify({ code: 'EVIDENCE_FIXTURE_NOT_FOUND', error: 'Sentetik fixture isteği tanımlı değil.' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  },
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter><App initialUser={user} /></BrowserRouter>
  </React.StrictMode>,
);
