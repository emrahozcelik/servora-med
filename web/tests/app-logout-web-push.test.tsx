/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state: { browserSubscription: { endpoint: string } | null } = {
    browserSubscription: { endpoint: 'https://push.example/subscription' },
  };
  const controller = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    setIdentity: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(() => () => {}),
    getSnapshot: vi.fn(() => ({
      enabled: null,
      status: null,
      capability: 'unsupported' as const,
      permission: 'unsupported' as const,
      guidance: 'none' as const,
      pending: null,
      error: '',
    })),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    recover: vi.fn().mockResolvedValue(undefined),
    clearLocalSubscription: vi.fn().mockImplementation(async () => {
      state.browserSubscription = null;
    }),
  };

  return {
    state,
    controller,
    createWebPushController: vi.fn(() => controller),
    createBrowserWebPushAdapter: vi.fn(() => ({})),
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    getCurrentUser: vi.fn(),
  };
});

vi.mock('../src/services/api', () => ({
  getCurrentUser: mocks.getCurrentUser,
  login: mocks.login,
  logout: mocks.logout,
}));

vi.mock('../src/web-push/BrowserWebPushAdapter', () => ({
  createBrowserWebPushAdapter: mocks.createBrowserWebPushAdapter,
}));

vi.mock('../src/web-push/WebPushController', () => ({
  createWebPushController: mocks.createWebPushController,
}));

vi.mock('../src/AppRouter', () => ({
  AppRouter: () => null,
}));

vi.mock('../src/realtime/RealtimeProvider', () => ({
  RealtimeProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock('../src/AppShell', () => ({
  AppShell: ({
    pendingSignOut,
    onSignOut,
    children,
  }: {
    pendingSignOut: boolean;
    onSignOut: () => void;
    children: unknown;
  }) => (
    <main>
      <button type="button" disabled={pendingSignOut} onClick={onSignOut} data-sign-out>
        Oturumu kapat
      </button>
      {children}
    </main>
  ),
}));

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

describe('App logout and Web Push lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.clearAllMocks();
    mocks.state.browserSubscription = { endpoint: 'https://push.example/subscription' };
    mocks.logout.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('revokes the auth session without destructively clearing the browser push subscription', async () => {
    await act(async () => root.render(<App initialUser={user} />));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-sign-out]')!.click();
    });

    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(mocks.controller.clearLocalSubscription).not.toHaveBeenCalled();
    expect(mocks.state.browserSubscription).not.toBeNull();
    expect(mocks.controller.stop).toHaveBeenCalledTimes(1);
  });
});
