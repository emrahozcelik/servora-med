/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const fingerprint = 'a'.repeat(64);
  const subscription = {
    endpoint: 'https://push.example/subscription',
    expirationTime: null,
    keys: { p256dh: 'p256dh', auth: 'auth' },
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  const browser = {
    capability: vi.fn(() => 'supported' as const),
    permission: vi.fn(() => 'granted' as const),
    isStandalone: vi.fn(() => false),
    requestPermission: vi.fn().mockResolvedValue('granted' as const),
    currentSubscription: vi.fn().mockResolvedValue(subscription),
    subscribe: vi.fn(),
    unsubscribe: vi.fn().mockResolvedValue(true),
    fingerprint: vi.fn().mockResolvedValue(fingerprint),
  };
  class TestApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  }

  return {
    fingerprint,
    subscription,
    browser,
    statusQueue: [] as Array<{
      enabled: boolean;
      vapidPublicKey: string | null;
      renewalRequired: boolean;
      subscription: { id: string; createdAt: string; fingerprint: string } | null;
    }>,
    createBrowserWebPushAdapter: vi.fn(() => browser),
    getStatus: vi.fn(),
    createSubscription: vi.fn(),
    recoverSubscription: vi.fn(),
    reconcileMissingSubscription: vi.fn(),
    disableSubscription: vi.fn(),
    getCurrentUser: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    notificationApi: {
      getUnreadNotificationCount: vi.fn().mockResolvedValue(0),
      listNotifications: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      markNotificationRead: vi.fn(),
      dismissNotification: vi.fn(),
      clearReadNotifications: vi.fn(),
      clearAllNotifications: vi.fn(),
    },
    TestApiError,
  };
});

vi.mock('../src/services/api', () => ({
  ApiError: mocks.TestApiError,
  getCurrentUser: mocks.getCurrentUser,
  login: mocks.login,
  logout: mocks.logout,
}));

vi.mock('../src/services/web-push-api', () => ({
  getWebPushStatus: mocks.getStatus,
  createWebPushSubscription: mocks.createSubscription,
  recoverWebPushSubscription: mocks.recoverSubscription,
  reconcileMissingWebPushSubscription: mocks.reconcileMissingSubscription,
  disableWebPushSubscription: mocks.disableSubscription,
}));

vi.mock('../src/web-push/BrowserWebPushAdapter', async () => {
  const actual = await vi.importActual<typeof import('../src/web-push/BrowserWebPushAdapter')>(
    '../src/web-push/BrowserWebPushAdapter',
  );
  return { ...actual, createBrowserWebPushAdapter: mocks.createBrowserWebPushAdapter };
});

vi.mock('../src/AppRouter', () => ({
  AppRouter: () => null,
}));

vi.mock('../src/realtime/RealtimeProvider', () => ({
  RealtimeProvider: ({ children }: { children: unknown }) => children,
  useRealtimeInvalidation: () => {},
}));

vi.mock('../src/services/notifications-api', () => mocks.notificationApi);

vi.mock('../src/AppShell', async () => {
  const { MemoryRouter } = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  const { NotificationCenter } = await vi.importActual<typeof import('../src/notifications/NotificationCenter')>(
    '../src/notifications/NotificationCenter',
  );

  return {
    AppShell: ({
      user,
      pendingSignOut,
      onSignOut,
      children,
    }: {
      user: CurrentUser;
      pendingSignOut: boolean;
      onSignOut: () => void;
      children: unknown;
    }) => (
      <MemoryRouter>
        <main>
          <div data-authenticated>{user.id}</div>
          <button type="button" disabled={pendingSignOut} onClick={onSignOut} data-sign-out>
            Oturumu kapat
          </button>
          <NotificationCenter identityKey={`${user.organizationId}:${user.id}`} mobile={false} />
          {children}
        </main>
      </MemoryRouter>
    ),
  };
});

import { App } from '../src/App';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const user: CurrentUser = {
  id: 'user-1',
  organizationId: 'org-1',
  name: 'Test Kullanıcısı',
  email: 'test@example.com',
  role: 'STAFF',
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

const sessionOneSubscription = {
  id: 'subscription-s1',
  createdAt: '2026-07-22T10:00:00.000Z',
  fingerprint: mocks.fingerprint,
};
const sessionTwoSubscription = {
  id: 'subscription-s2',
  createdAt: '2026-07-22T11:00:00.000Z',
  fingerprint: mocks.fingerprint,
};

function activeStatus(subscription: typeof sessionOneSubscription | null) {
  return {
    enabled: true,
    vapidPublicKey: 'AQID',
    renewalRequired: false,
    subscription,
  };
}

function findButton(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent === text);
}

async function openNotificationSettings(container: HTMLElement) {
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Bildirimler"]')).not.toBeNull());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!.click());
  await vi.waitFor(() => expect(findButton(container, 'Kurulum ve cihaz bildirimleri')).toBeTruthy());
  await act(async () => findButton(container, 'Kurulum ve cihaz bildirimleri')!.click());
}

describe('App logout and Web Push lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.clearAllMocks();
    mocks.statusQueue = [];
    mocks.createBrowserWebPushAdapter.mockReturnValue(mocks.browser);
    mocks.browser.currentSubscription.mockResolvedValue(mocks.subscription);
    mocks.browser.requestPermission.mockResolvedValue('granted');
    mocks.browser.subscribe.mockResolvedValue(mocks.subscription);
    mocks.browser.unsubscribe.mockResolvedValue(true);
    mocks.browser.fingerprint.mockResolvedValue(mocks.fingerprint);
    mocks.getStatus.mockImplementation(async () => mocks.statusQueue.shift() ?? activeStatus(sessionTwoSubscription));
    mocks.createSubscription.mockResolvedValue(sessionTwoSubscription);
    mocks.recoverSubscription.mockResolvedValue({ rebound: true });
    mocks.reconcileMissingSubscription.mockResolvedValue(undefined);
    mocks.disableSubscription.mockResolvedValue(undefined);
    mocks.login.mockResolvedValue(user);
    mocks.logout.mockResolvedValue(undefined);
    mocks.notificationApi.getUnreadNotificationCount.mockResolvedValue(0);
    mocks.notificationApi.listNotifications.mockResolvedValue({ items: [], nextCursor: null });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('uses the real App/provider/controller for logout, same-user login, and silent rebind', async () => {
    mocks.statusQueue.push(
      activeStatus(sessionOneSubscription),
      activeStatus(sessionOneSubscription),
      activeStatus(null),
      activeStatus(null),
      activeStatus(sessionTwoSubscription),
    );

    await act(async () => root.render(<App initialUser={user} />));
    await vi.waitFor(() => expect(mocks.browser.currentSubscription).toHaveBeenCalledTimes(1));

    const beforeLogoutStatusCalls = mocks.getStatus.mock.calls.length;
    await act(async () => container.querySelector<HTMLButtonElement>('[data-sign-out]')!.click());
    await vi.waitFor(() => expect(container.querySelector('form')).not.toBeNull());

    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(mocks.browser.unsubscribe).not.toHaveBeenCalled();
    expect(mocks.browser.currentSubscription).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.getStatus).toHaveBeenCalledTimes(beforeLogoutStatusCalls);

    const email = container.querySelector<HTMLInputElement>('input[name="email"]')!;
    const password = container.querySelector<HTMLInputElement>('input[name="password"]')!;
    email.value = user.email;
    password.value = 'test-password';
    await act(async () => {
      container.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    await vi.waitFor(() => expect(mocks.login).toHaveBeenCalledWith({
      email: user.email,
      password: 'test-password',
    }));
    await vi.waitFor(() => expect(mocks.recoverSubscription).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(container.querySelector('[data-authenticated]')).not.toBeNull());

    expect(mocks.recoverSubscription).toHaveBeenCalledWith({
      endpoint: mocks.subscription.endpoint,
      expirationTime: mocks.subscription.expirationTime,
      keys: mocks.subscription.keys,
    });
    expect(mocks.browser.requestPermission).not.toHaveBeenCalled();
    expect(mocks.browser.subscribe).not.toHaveBeenCalled();
    expect(mocks.browser.unsubscribe).not.toHaveBeenCalled();
    expect(mocks.createSubscription).not.toHaveBeenCalled();

    await openNotificationSettings(container);
    await vi.waitFor(() => expect(findButton(container, 'Cihaz bildirimlerini kapat')).toBeTruthy());
    expect(findButton(container, 'Cihaz bildirimlerini aç')).toBeUndefined();
    expect(mocks.getStatus).toHaveBeenCalledTimes(5);
  });

  it('keeps the authenticated provider alive and the browser subscription untouched when logout fails', async () => {
    mocks.statusQueue.push(activeStatus(sessionOneSubscription), activeStatus(sessionOneSubscription));
    mocks.logout.mockRejectedValueOnce(new Error('logout failed'));

    await act(async () => root.render(<App initialUser={user} />));
    await vi.waitFor(() => expect(mocks.browser.currentSubscription).toHaveBeenCalledTimes(1));
    const statusCallsBeforeFailedLogoutRecovery = mocks.getStatus.mock.calls.length;

    await act(async () => container.querySelector<HTMLButtonElement>('[data-sign-out]')!.click());
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());

    expect(container.querySelector('[data-authenticated]')).not.toBeNull();
    expect(container.querySelector('form')).toBeNull();
    expect(mocks.browser.unsubscribe).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mocks.getStatus.mock.calls.length).toBeGreaterThan(statusCallsBeforeFailedLogoutRecovery));
    await vi.waitFor(() => expect(mocks.browser.currentSubscription.mock.calls.length).toBeGreaterThan(1));
    expect(mocks.browser.unsubscribe).not.toHaveBeenCalled();
  });
});
