import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';

import { NotificationCenter } from '../src/notifications/NotificationCenter';
import { WebPushProvider } from '../src/web-push/WebPushProvider';
import type { WebPushController, WebPushSnapshot } from '../src/web-push/WebPushController';

const notification = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'job.revision_requested',
  title: 'Düzeltme istendi — çok uzun bir operasyon başlığı',
  body: 'Bu uzun bildirim metni 400% reflow altında satıra sarılmalı; hiçbir hassas iş kaydı veya müşteri verisi taşırmamalıdır.',
  entity: { type: 'job-card', id: '22222222-2222-4222-8222-222222222222' },
  createdAt: '2026-07-21T10:00:00.000Z',
  readAt: null,
};

const LONG_ERROR =
  'Cihaz bildirimi durumu şu anda doğrulanamadı. İnternet bağlantınızı kontrol edip bu ekranı kapatmadan yeniden deneyin. Sorun devam ederse uygulamayı tekrar açın.';

type PushStateName =
  | 'loading'
  | 'disabled'
  | 'unsupported'
  | 'install-required'
  | 'denied'
  | 'enabled-not-subscribed'
  | 'enabled-subscribed'
  | 'renewal-required'
  | 'pending-enable'
  | 'pending-disable'
  | 'long-error';

function readPushState(): PushStateName {
  const raw = new URLSearchParams(window.location.search).get('pushState');
  const allowed: PushStateName[] = [
    'loading', 'disabled', 'unsupported', 'install-required', 'denied',
    'enabled-not-subscribed', 'enabled-subscribed', 'renewal-required',
    'pending-enable', 'pending-disable', 'long-error',
  ];
  return (allowed.includes(raw as PushStateName) ? raw : 'disabled') as PushStateName;
}

function snapshotFor(state: PushStateName): WebPushSnapshot {
  const base = {
    enabled: true as boolean | null,
    status: {
      enabled: true,
      vapidPublicKey: 'AQID',
      renewalRequired: false,
      subscription: null as null | { id: string; createdAt: string; fingerprint: string },
    },
    capability: 'supported' as const,
    permission: 'default' as const,
    guidance: 'none' as WebPushSnapshot['guidance'],
    pending: null as WebPushSnapshot['pending'],
    error: '',
  };

  switch (state) {
    case 'loading':
      return {
        enabled: null,
        status: null,
        capability: 'supported',
        permission: 'default',
        guidance: 'none',
        pending: null,
        error: '',
      };
    case 'disabled':
      return {
        enabled: false,
        status: { enabled: false, vapidPublicKey: null, renewalRequired: false, subscription: null },
        capability: 'supported',
        permission: 'default',
        guidance: 'disabled',
        pending: null,
        error: '',
      };
    case 'unsupported':
      return { ...base, capability: 'unsupported', permission: 'unsupported', guidance: 'unsupported' };
    case 'install-required':
      return { ...base, capability: 'unsupported', permission: 'unsupported', guidance: 'install-required' };
    case 'denied':
      return { ...base, permission: 'denied', guidance: 'denied' };
    case 'enabled-not-subscribed':
      return base;
    case 'enabled-subscribed':
      return {
        ...base,
        status: {
          enabled: true,
          vapidPublicKey: 'AQID',
          renewalRequired: false,
          subscription: {
            id: 'sub-1',
            createdAt: '2026-07-22T10:00:00.000Z',
            fingerprint: 'a'.repeat(64),
          },
        },
      };
    case 'renewal-required':
      return {
        ...base,
        guidance: 'renewal-required',
        status: {
          enabled: true,
          vapidPublicKey: 'AQID',
          renewalRequired: true,
          subscription: {
            id: 'sub-1',
            createdAt: '2026-07-22T10:00:00.000Z',
            fingerprint: 'a'.repeat(64),
          },
        },
      };
    case 'pending-enable':
      return { ...base, pending: 'enable' };
    case 'pending-disable':
      return {
        ...base,
        pending: 'disable',
        status: {
          enabled: true,
          vapidPublicKey: 'AQID',
          renewalRequired: false,
          subscription: {
            id: 'sub-1',
            createdAt: '2026-07-22T10:00:00.000Z',
            fingerprint: 'a'.repeat(64),
          },
        },
      };
    case 'long-error':
      return { ...base, error: LONG_ERROR };
    default:
      return {
        enabled: false,
        status: { enabled: false, vapidPublicKey: null, renewalRequired: false, subscription: null },
        capability: 'supported',
        permission: 'default',
        guidance: 'disabled',
        pending: null,
        error: '',
      };
  }
}

function createFixtureController(snapshot: WebPushSnapshot): WebPushController {
  const listeners = new Set<() => void>();
  let current = snapshot;
  return {
    start: async () => {},
    stop: () => {},
    setIdentity: async () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => current,
    enable: async () => {},
    disable: async () => {},
    recover: async () => {},
    clearLocalSubscription: async () => {},
  };
}

window.fetch = async (input) => {
  const path = String(input);
  if (path.includes('/api/web-push/status')) {
    return new Response(JSON.stringify({
      enabled: false, vapidPublicKey: null, renewalRequired: false, subscription: null,
    }), { status: 200 });
  }
  if (path.includes('/unread-count')) return new Response(JSON.stringify({ unreadCount: 123 }), { status: 200 });
  if (path.includes('/api/notifications?')) {
    return new Response(JSON.stringify({
      items: [
        notification,
        { ...notification, id: '33333333-3333-4333-8333-333333333333', readAt: '2026-07-21T11:00:00.000Z' },
      ],
      nextCursor: 'next-page',
    }), { status: 200 });
  }
  return new Response(JSON.stringify({ ...notification, readAt: '2026-07-21T11:00:00.000Z' }), { status: 200 });
};

const pushState = readPushState();
const controller = createFixtureController(snapshotFor(pushState));
const root = document.getElementById('responsive-notification-center-root');
if (root) {
  flushSync(() => createRoot(root).render(
    <MemoryRouter>
      <div data-smoke-notification-center="true" data-push-state={pushState}>
        <WebPushProvider identityKey="org-1:staff-1" controller={controller}>
          <NotificationCenter identityKey="org-1:staff-1" mobile={window.innerWidth < 1024} />
        </WebPushProvider>
      </div>
    </MemoryRouter>,
  ));
  root.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')?.click();
}
