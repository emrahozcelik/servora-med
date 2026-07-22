/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationCenter } from '../src/notifications/NotificationCenter';
import {
  createInstallOpportunityController,
  InstallOpportunityProvider,
} from '../src/install/InstallOpportunity';
import { RealtimeProvider, type RealtimeEventSource } from '../src/realtime/RealtimeProvider';
import { WebPushProvider } from '../src/web-push/WebPushProvider';
import type { WebPushController } from '../src/web-push/WebPushController';

const api = vi.hoisted(() => ({
  getUnreadNotificationCount: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
}));
vi.mock('../src/services/notifications-api', () => api);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const notification = {
  id: '11111111-1111-4111-8111-111111111111', kind: 'job.assigned' as const,
  title: 'Yeni iş atandı', body: 'Size yeni bir iş atandı.',
  entity: { type: 'job-card' as const, id: '22222222-2222-4222-8222-222222222222' },
  createdAt: '2026-07-21T10:00:00.000Z', readAt: null,
};

class FakeEventSource implements RealtimeEventSource {
  readonly listeners = new Map<string, Set<EventListener>>();
  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener); this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  close() {}
  emit(type: string, data?: string) {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data });
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

describe('NotificationCenter', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    api.getUnreadNotificationCount.mockResolvedValue(2);
    api.listNotifications.mockResolvedValue({ items: [notification], nextCursor: null });
    api.markNotificationRead.mockResolvedValue({ ...notification, readAt: '2026-07-21T11:00:00.000Z' });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render(identityKey = 'org-1:staff-1', mobile = false) {
    await act(async () => root.render(
      <MemoryRouter><NotificationCenter identityKey={identityKey} mobile={mobile} /></MemoryRouter>,
    ));
  }

  it('loads the badge and opens a labelled notification panel with semantic content', async () => {
    await render();
    await act(async () => {});
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    expect(trigger.textContent).toContain('2');
    trigger.focus();
    await act(async () => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Yeni iş atandı');
    expect(dialog.textContent).toContain('Size yeni bir iş atandı.');
    expect(dialog.textContent).toContain('Okunmadı');
    expect(document.activeElement).toBe(dialog.querySelector('button'));
  });

  it('closes the desktop panel on outside pointer down and keeps it open for panel clicks', async () => {
    await render('org-1:staff-1', false);
    await act(async () => {});
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    trigger.focus();
    await act(async () => trigger.click());
    const layer = container.querySelector('.notification-center-desktop-layer')!;
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();

    await act(async () => {
      dialog.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    const settings = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Kurulum ve cihaz bildirimleri')!;
    await act(async () => settings.click());
    expect(container.textContent).toContain('Kurulum ve cihaz bildirimleri');

    await act(async () => {
      layer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {});
    expect(document.activeElement).toBe(trigger);

    await act(async () => trigger.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('closes the mobile panel from the backdrop control without double-close issues', async () => {
    await render('org-1:staff-1', true);
    await act(async () => {});
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const backdrop = container.querySelector<HTMLButtonElement>(
      '.notification-center-backdrop-button',
    )!;
    await act(async () => backdrop.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('offers a retained install prompt only from the explicit settings action', async () => {
    const controller = createInstallOpportunityController(window);
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted', platform: '' }),
    });
    controller.start();
    window.dispatchEvent(event);

    await act(async () => root.render(
      <MemoryRouter>
        <InstallOpportunityProvider controller={controller}>
          <NotificationCenter identityKey="org-1:staff-1" mobile={false} />
        </InstallOpportunityProvider>
      </MemoryRouter>,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    const settings = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Kurulum ve cihaz bildirimleri')!;
    await act(async () => settings.click());
    const install = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Uygulamayı yükle')!;

    expect(prompt).not.toHaveBeenCalled();
    await act(async () => install.click());
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Uygulama bu cihaza yüklendi.');
    controller.stop();
  });

  it('shows manual install guidance and returns focus without touching notification APIs', async () => {
    const requestPermission = vi.fn();
    const register = vi.fn();
    vi.stubGlobal('Notification', { requestPermission });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register },
    });
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    const settings = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Kurulum ve cihaz bildirimleri')!;
    settings.focus();
    await act(async () => settings.click());

    expect(container.textContent).toContain('Siteyi yükle');
    expect(container.textContent).toContain('Dock’a Ekle');
    expect(container.textContent).toContain('Ana Ekrana Ekle');
    expect(container.textContent).toContain('iPhone veya iPad');
    expect(container.textContent).toContain('Cihaz bildirimleri şu anda kullanıma kapalıdır.');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    const back = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Bildirimlere dön')!;
    expect(document.activeElement).toBe(back);
    await act(async () => back.click());
    const restoredSettings = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Kurulum ve cihaz bildirimleri')!;
    expect(document.activeElement).toBe(restoredSettings);
    delete (navigator as Navigator & { serviceWorker?: unknown }).serviceWorker;
  });

  function fakeWebPush(
    snapshot: ReturnType<WebPushController['getSnapshot']>,
    handlers: { enable?: () => Promise<void>; disable?: () => Promise<void> } = {},
  ): WebPushController {
    return {
      start: async () => {},
      stop: () => {},
      setIdentity: async () => {},
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
      enable: handlers.enable ?? (async () => {}),
      disable: handlers.disable ?? (async () => {}),
      recover: async () => {},
      clearLocalSubscription: async () => {},
    };
  }

  async function openSettingsWithWebPush(webPush: WebPushController) {
    await act(async () => root.render(
      <MemoryRouter>
        <WebPushProvider identityKey="org-1:staff-1" controller={webPush}>
          <NotificationCenter identityKey="org-1:staff-1" mobile={false} />
        </WebPushProvider>
      </MemoryRouter>,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    const settings = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Kurulum ve cihaz bildirimleri')!;
    await act(async () => settings.click());
  }

  it('renders the enabled device-notification action from the owned controller state', async () => {
    const enable = vi.fn().mockResolvedValue(undefined);
    const webPush = fakeWebPush({
      enabled: true,
      status: { enabled: true, vapidPublicKey: 'AQID', renewalRequired: false, subscription: null },
      capability: 'supported', permission: 'default', guidance: 'none', pending: null, error: '',
    }, { enable });
    await openSettingsWithWebPush(webPush);
    const action = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Cihaz bildirimlerini aç')!;

    expect(container.textContent).toContain('müşteri, not, teslimat veya konum bilgisi yer almaz');
    await act(async () => action.click());
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it('shows an accessible loading status while device notification state is unknown', async () => {
    await openSettingsWithWebPush(fakeWebPush({
      enabled: null, status: null, capability: 'supported', permission: 'default',
      guidance: 'none', pending: null, error: '',
    }));
    const loading = container.querySelector('.notification-device-push [role="status"]');
    expect(loading?.textContent).toContain('Cihaz bildirimi durumu yükleniyor…');
    const actionButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) =>
        button.textContent === 'Cihaz bildirimlerini aç'
        || button.textContent === 'Cihaz bildirimlerini kapat',
      );
    expect(actionButton).toBeUndefined();
  });

  it.each([
    {
      name: 'disabled',
      snapshot: {
        enabled: false as boolean | null,
        status: { enabled: false, vapidPublicKey: null, renewalRequired: false, subscription: null },
        capability: 'supported' as const, permission: 'default' as const,
        guidance: 'disabled' as const, pending: null, error: '',
      },
      text: 'Cihaz bildirimleri şu anda kullanıma kapalıdır.',
      action: null as string | null,
    },
    {
      name: 'denied',
      snapshot: {
        enabled: true as boolean | null,
        status: { enabled: true, vapidPublicKey: 'AQID', renewalRequired: false, subscription: null },
        capability: 'supported' as const, permission: 'denied' as const,
        guidance: 'denied' as const, pending: null, error: '',
      },
      text: 'Bildirim izni kapalı',
      action: null,
    },
    {
      name: 'install-required',
      snapshot: {
        enabled: true as boolean | null,
        status: { enabled: true, vapidPublicKey: 'AQID', renewalRequired: false, subscription: null },
        capability: 'unsupported' as const, permission: 'unsupported' as const,
        guidance: 'install-required' as const, pending: null, error: '',
      },
      text: 'Ana Ekrana ekleyip',
      action: null,
    },
    {
      name: 'renewal-required',
      snapshot: {
        enabled: true as boolean | null,
        status: {
          enabled: true, vapidPublicKey: 'AQID', renewalRequired: true,
          subscription: { id: 's1', createdAt: '2026-07-22T10:00:00.000Z', fingerprint: 'a'.repeat(64) },
        },
        capability: 'supported' as const, permission: 'granted' as const,
        guidance: 'renewal-required' as const, pending: null, error: '',
      },
      text: 'aboneliği yenilenmeli',
      action: 'Cihaz bildirimlerini yenile',
    },
    {
      name: 'long-error',
      snapshot: {
        enabled: true as boolean | null,
        status: { enabled: true, vapidPublicKey: 'AQID', renewalRequired: false, subscription: null },
        capability: 'supported' as const, permission: 'default' as const,
        guidance: 'none' as const, pending: null,
        error: 'Cihaz bildirimi durumu şu anda doğrulanamadı. İnternet bağlantınızı kontrol edip bu ekranı kapatmadan yeniden deneyin.',
      },
      text: 'Cihaz bildirimi durumu şu anda doğrulanamadı',
      action: 'Cihaz bildirimlerini aç',
    },
  ])('renders device notification $name guidance without inventing push SSE events', async ({ snapshot, text, action }) => {
    await openSettingsWithWebPush(fakeWebPush(snapshot));
    expect(container.textContent).toContain(text);
    const actionButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) =>
        button.textContent === 'Cihaz bildirimlerini aç'
        || button.textContent === 'Cihaz bildirimlerini kapat'
        || button.textContent === 'Cihaz bildirimlerini yenile'
        || button.textContent === 'Açılıyor…'
        || button.textContent === 'Kapatılıyor…'
        || button.textContent === 'Yenileniyor…',
      );
    if (action) {
      expect(actionButton?.textContent).toBe(action);
    } else {
      expect(actionButton).toBeUndefined();
    }
    const alert = container.querySelector('[role="alert"]');
    if (snapshot.error) expect(alert?.textContent).toContain(snapshot.error.slice(0, 20));
  });

  it('disables pending enable action and marks the section busy', async () => {
    await openSettingsWithWebPush(fakeWebPush({
      enabled: true,
      status: { enabled: true, vapidPublicKey: 'AQID', renewalRequired: false, subscription: null },
      capability: 'supported', permission: 'default', guidance: 'none', pending: 'enable', error: '',
    }));
    const action = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Açılıyor…')!;
    expect(action.disabled).toBe(true);
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.notification-device-push')?.getAttribute('aria-busy')).toBe('true');
  });

  it('shows an empty state and supports retry after a list failure', async () => {
    api.listNotifications.mockRejectedValueOnce(new Error('Bağlantı koptu')).mockResolvedValueOnce({ items: [], nextCursor: null });
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    expect(container.textContent).toContain('Bağlantı koptu');
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Tekrar dene')!;
    await act(async () => retry.click());
    expect(container.textContent).toContain('Henüz bildiriminiz yok.');
  });

  it('marks before navigating and locks only the pending notification action', async () => {
    let resolveMark: ((value: typeof notification & { readAt: string }) => void) | undefined;
    api.markNotificationRead.mockImplementationOnce(() => new Promise((resolve) => { resolveMark = resolve; }));
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    const action = container.querySelector<HTMLButtonElement>('[data-notification-id]')!;
    await act(async () => action.click());
    await act(async () => action.click());
    expect(action.disabled).toBe(true);
    expect(api.markNotificationRead).toHaveBeenCalledTimes(1);
    expect(api.markNotificationRead).toHaveBeenCalledWith(notification.id);
    await act(async () => resolveMark!({ ...notification, readAt: '2026-07-21T11:00:00.000Z' }));
    expect(api.getUnreadNotificationCount).toHaveBeenCalledTimes(2);
  });

  it('deduplicates later pages and keeps the panel open when mark-read fails', async () => {
    const later = {
      ...notification,
      id: '33333333-3333-4333-8333-333333333333',
      title: 'İş onaylandı', kind: 'job.approved' as const, body: 'İşiniz onaylandı.',
    };
    api.listNotifications
      .mockResolvedValueOnce({ items: [notification], nextCursor: 'more' })
      .mockResolvedValueOnce({ items: [notification, later], nextCursor: null });
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    const more = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Daha fazla yükle')!;
    await act(async () => more.click());
    expect(container.querySelectorAll('[data-notification-id]')).toHaveLength(2);

    api.markNotificationRead.mockRejectedValueOnce(new Error('Okunamadı'));
    const action = container.querySelector<HTMLButtonElement>('[data-notification-id]')!;
    await act(async () => action.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain('Okunamadı');
  });

  it('closes with Escape and restores focus to the trigger', async () => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    trigger.focus();
    await act(async () => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it.each([false, true])('keeps keyboard focus within the %s panel and cleans up after close', async (mobile) => {
    await render('org-1:staff-1', mobile);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    trigger.focus();
    await act(async () => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(dialog.id);
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    const focusable = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    const first = focusable[0]!; const last = focusable.at(-1)!;
    last.focus();
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(document.activeElement).toBe(first);
    first.focus();
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })));
    expect(document.activeElement).toBe(last);
    const outside = document.createElement('button'); document.body.append(outside); outside.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    outside.remove();
    await act(async () => first.click());
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(trigger);
  });

  it('clears recipient-scoped panel state before loading a different identity', async () => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    api.getUnreadNotificationCount.mockResolvedValue(0);
    await render('org-2:staff-2');
    await act(async () => {});
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[data-notification-id]')).toBeNull();
    expect(container.querySelector('[aria-label="Bildirimler"]')?.textContent).not.toContain('2');
  });

  it('reloads canonical data after a notifications realtime invalidation', async () => {
    const listeners = new Map<string, EventListener>();
    const eventSource: RealtimeEventSource = {
      addEventListener: (type, listener) => { listeners.set(type, listener); },
      removeEventListener: (type) => { listeners.delete(type); },
      close: () => {},
    };
    await act(async () => root.render(
      <MemoryRouter>
        <RealtimeProvider eventSourceFactory={() => eventSource}>
          <NotificationCenter identityKey="org-1:staff-1" mobile={false} />
        </RealtimeProvider>
      </MemoryRouter>,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    await act(async () => listeners.get('servora.change')!(new MessageEvent('servora.change', {
      data: JSON.stringify({
        id: '1', type: 'job.approved', entity: { type: 'job-card', id: 'job-1' },
        resourceKeys: ['notifications'], occurredAt: '2026-07-21T12:00:00.000Z',
      }),
    })));
    expect(api.getUnreadNotificationCount).toHaveBeenCalledTimes(2);
    expect(api.listNotifications).toHaveBeenCalledTimes(2);
  });

  it('does not mark-read or refresh notification APIs for push-subscription-changed recovery', async () => {
    const { createWebPushController } = await import('../src/web-push/WebPushController');
    const swListeners = new Set<(event: Event) => void>();
    const serviceWorkerTarget = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        if (type === 'message') swListeners.add(listener as (event: Event) => void);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        if (type === 'message') swListeners.delete(listener as (event: Event) => void);
      }),
    };
    const getStatus = vi.fn().mockResolvedValue({
      enabled: true,
      vapidPublicKey: 'AQID',
      renewalRequired: false,
      subscription: {
        id: 'sub-1',
        createdAt: '2026-07-22T10:00:00.000Z',
        fingerprint: 'a'.repeat(64),
      },
    });
    const controller = createWebPushController({
      api: {
        getStatus,
        createSubscription: vi.fn(),
        disableSubscription: vi.fn(),
      },
      browser: {
        capability: () => 'supported' as const,
        permission: () => 'granted' as const,
        isStandalone: () => true,
        requestPermission: vi.fn(),
        currentSubscription: vi.fn().mockResolvedValue({
          endpoint: 'https://fcm.googleapis.com/push/example',
          expirationTime: null,
          keys: { p256dh: 'p', auth: 'a' },
          unsubscribe: vi.fn().mockResolvedValue(true),
        }),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        fingerprint: vi.fn().mockResolvedValue('a'.repeat(64)),
      },
      target: window,
      serviceWorkerTarget,
    });

    await act(async () => root.render(
      <MemoryRouter>
        <WebPushProvider identityKey="org-1:staff-1" controller={controller}>
          <NotificationCenter identityKey="org-1:staff-1" mobile={false} />
        </WebPushProvider>
      </MemoryRouter>,
    ));

    const listCallsBefore = api.listNotifications.mock.calls.length;
    const unreadBefore = api.getUnreadNotificationCount.mock.calls.length;
    const markBefore = api.markNotificationRead.mock.calls.length;
    const statusBefore = getStatus.mock.calls.length;

    await act(async () => {
      for (const listener of swListeners) {
        listener(new MessageEvent('message', { data: { type: 'push-subscription-changed' } }));
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getStatus.mock.calls.length).toBeGreaterThan(statusBefore);
    expect(api.markNotificationRead).toHaveBeenCalledTimes(markBefore);
    expect(api.listNotifications).toHaveBeenCalledTimes(listCallsBefore);
    expect(api.getUnreadNotificationCount).toHaveBeenCalledTimes(unreadBefore);
  });

  it('uses the same guarded loaders for recovery, and loads the list only while open', async () => {
    vi.useFakeTimers();
    const source = new FakeEventSource();
    await act(async () => root.render(
      <MemoryRouter>
        <RealtimeProvider eventSourceFactory={() => source}>
          <NotificationCenter identityKey="org-1:staff-1" mobile={false} />
        </RealtimeProvider>
      </MemoryRouter>,
    ));
    await act(async () => {
      source.emit('open');
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(api.getUnreadNotificationCount).toHaveBeenCalledTimes(2);
    expect(api.listNotifications).not.toHaveBeenCalled();

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    await act(async () => { source.emit('error'); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.getUnreadNotificationCount).toHaveBeenCalledTimes(3);
    expect(api.listNotifications).toHaveBeenCalledTimes(2);

    await act(async () => { source.emit('open'); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.getUnreadNotificationCount).toHaveBeenCalledTimes(4);
    expect(api.listNotifications).toHaveBeenCalledTimes(3);
  });

  it('does not let an older list response overwrite a newer invalidation reload', async () => {
    let resolveFirst: ((page: { items: typeof notification[]; nextCursor: null }) => void) | undefined;
    let resolveSecond: ((page: { items: typeof notification[]; nextCursor: null }) => void) | undefined;
    api.listNotifications.mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const source = new FakeEventSource();
    await act(async () => root.render(
      <MemoryRouter><RealtimeProvider eventSourceFactory={() => source}>
        <NotificationCenter identityKey="org-1:staff-1" mobile={false} />
      </RealtimeProvider></MemoryRouter>,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    await act(async () => source.emit('servora.change', JSON.stringify({
      id: '1', type: 'job.approved', entity: { type: 'job-card', id: 'job-1' },
      resourceKeys: ['notifications'], occurredAt: '2026-07-21T12:00:00.000Z',
    })));
    const newer = { ...notification, title: 'Yeni canonical kayıt' };
    await act(async () => resolveSecond!({ items: [newer], nextCursor: null }));
    await act(async () => resolveFirst!({ items: [notification], nextCursor: null }));
    expect(container.textContent).toContain('Yeni canonical kayıt');
    expect(container.textContent).not.toContain('Yeni iş atandı');
  });
});
