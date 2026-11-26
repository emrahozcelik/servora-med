/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CurrentUser } from '../src/services/api';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  latest: { user: null as unknown, onOverviewUnavailable: undefined as undefined | (() => void) },
}));

vi.mock('../src/services/api', async () => {
  const actual = await vi.importActual<typeof import('../src/services/api')>('../src/services/api');
  return { ...actual, getCurrentUser: mocks.getCurrentUser, login: mocks.login, logout: mocks.logout };
});

vi.mock('../src/AppRouter', () => ({
  AppRouter: (props: { user: CurrentUser; onOverviewUnavailable?: () => void }) => {
    mocks.latest.user = props.user;
    mocks.latest.onOverviewUnavailable = props.onOverviewUnavailable;
    return <div data-router data-overview={String(props.user.capabilities.overviewDashboard)} />;
  },
}));

vi.mock('../src/AppShell', () => ({
  AppShell: ({ children, onSignOut }: { children: unknown; onSignOut: () => void }) => (
    <main><button type="button" data-sign-out onClick={onSignOut}>Çıkış</button>{children as never}</main>
  ),
}));

vi.mock('../src/realtime/RealtimeProvider', () => ({
  RealtimeProvider: ({ children }: { children: unknown }) => children,
  useRealtimeInvalidation: () => {},
}));

vi.mock('../src/web-push/BrowserWebPushAdapter', () => ({ createBrowserWebPushAdapter: () => ({}) }));
vi.mock('../src/web-push/WebPushController', () => ({ createWebPushController: () => ({}) }));
vi.mock('../src/web-push/WebPushProvider', () => ({
  WebPushProvider: ({ children }: { children: unknown }) => children,
}));

import { App } from '../src/App';
import { IDENTITY_REVALIDATION_MIN_INTERVAL_MS, useIdentityRevalidation } from '../src/identity-revalidation';
import { ApiError } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const baseUser: CurrentUser = {
  id: 'user-1', organizationId: 'org-1', name: 'Ayşe Yönetici', email: 'manager@example.com',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const withOverview = (on: boolean): CurrentUser => ({
  ...baseUser, capabilities: { ...baseUser.capabilities, overviewDashboard: on },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

describe('customer identity revalidation', () => {
  let container: HTMLDivElement;
  let root: Root;
  const startedAt = new Date('2026-11-26T09:00:00.000Z');

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);
    setVisibility('visible');
    mocks.getCurrentUser.mockReset();
    mocks.login.mockReset();
    mocks.logout.mockReset();
    mocks.latest.user = null;
    mocks.latest.onOverviewUnavailable = undefined;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter initialEntries={['/jobs']}><App initialUser={withOverview(false)} /></MemoryRouter>));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  const focusWindow = () => act(async () => { window.dispatchEvent(new Event('focus')); });
  const overviewFlag = () => container.querySelector('[data-router]')?.getAttribute('data-overview');
  const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

  it('does not request anything until the tab regains focus or visibility', () => {
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });

  it('applies a changed capability from /api/auth/me without leaving the page', async () => {
    mocks.getCurrentUser.mockResolvedValue(withOverview(true));
    await focusWindow();
    await vi.waitFor(() => expect(overviewFlag()).toBe('true'));
    expect(mocks.getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it('keeps the identical user object when nothing changed', async () => {
    const before = mocks.latest.user;
    mocks.getCurrentUser.mockResolvedValue(withOverview(false));
    await focusWindow();
    await vi.waitFor(() => expect(mocks.getCurrentUser).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.latest.user).toBe(before);
  });

  it('throttles automatic revalidation and allows the next one after the interval', async () => {
    mocks.getCurrentUser.mockResolvedValue(withOverview(false));
    await focusWindow();
    await vi.waitFor(() => expect(mocks.getCurrentUser).toHaveBeenCalledTimes(1));

    advance(IDENTITY_REVALIDATION_MIN_INTERVAL_MS - 1_000);
    await focusWindow();
    expect(mocks.getCurrentUser).toHaveBeenCalledTimes(1);

    advance(2_000);
    await focusWindow();
    await vi.waitFor(() => expect(mocks.getCurrentUser).toHaveBeenCalledTimes(2));
  });

  it('keeps a single request in flight across focus and visibilitychange', async () => {
    const pending = deferred<CurrentUser | null>();
    mocks.getCurrentUser.mockReturnValue(pending.promise);
    await focusWindow();
    advance(IDENTITY_REVALIDATION_MIN_INTERVAL_MS + 1_000);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await focusWindow();
    expect(mocks.getCurrentUser).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve(withOverview(true)));
    await vi.waitFor(() => expect(overviewFlag()).toBe('true'));
  });

  it('ignores focus and visibilitychange while the tab is hidden', async () => {
    mocks.getCurrentUser.mockResolvedValue(withOverview(true));
    setVisibility('hidden');
    await focusWindow();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();

    setVisibility('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await vi.waitFor(() => expect(mocks.getCurrentUser).toHaveBeenCalledTimes(1));
  });

  it('logs out on a 401 (the identity call reports no session)', async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    await focusWindow();
    await vi.waitFor(() => expect(container.querySelector('#login-title')).not.toBeNull());
    expect(container.querySelector('[data-router]')).toBeNull();
  });

  it.each([
    ['a network failure', new ApiError(0, 'NETWORK_ERROR', 'Sunucuya ulaşılamadı.', true)],
    ['a 5xx response', new ApiError(503, 'UNAVAILABLE', 'Hizmet yok.', true)],
  ])('keeps the current identity on %s', async (_name, failure) => {
    const before = mocks.latest.user;
    mocks.getCurrentUser.mockRejectedValue(failure);
    await focusWindow();
    await vi.waitFor(() => expect(mocks.getCurrentUser).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('[data-router]')).not.toBeNull();
    expect(container.querySelector('#login-title')).toBeNull();
    expect(mocks.latest.user).toBe(before);
  });

  it('ignores a response that arrives after logout and after a new login', async () => {
    const stale = deferred<CurrentUser | null>();
    mocks.getCurrentUser.mockReturnValue(stale.promise);
    await focusWindow();
    expect(mocks.getCurrentUser).toHaveBeenCalledTimes(1);

    mocks.logout.mockResolvedValue(undefined);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-sign-out]')!.click());
    await vi.waitFor(() => expect(container.querySelector('#login-title')).not.toBeNull());

    // Late answer while signed out: must not resurrect the old identity.
    await act(async () => stale.resolve(withOverview(true)));
    expect(container.querySelector('[data-router]')).toBeNull();
    expect(container.querySelector('#login-title')).not.toBeNull();

    // New login (overview off); a second stale answer must not overwrite it either.
    const secondStale = deferred<CurrentUser | null>();
    mocks.getCurrentUser.mockReturnValue(secondStale.promise);
    mocks.login.mockResolvedValue(withOverview(false));
    container.querySelector<HTMLInputElement>('#email')!.value = 'manager@example.com';
    container.querySelector<HTMLInputElement>('#password')!.value = 'a-test-password';
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await vi.waitFor(() => expect(container.querySelector('[data-router]')).not.toBeNull());
    expect(overviewFlag()).toBe('false');

    await focusWindow();
    expect(mocks.getCurrentUser).toHaveBeenCalledTimes(2);
    // Leave the tab now: the session is replaced before the answer arrives.
    mocks.logout.mockResolvedValue(undefined);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-sign-out]')!.click());
    await vi.waitFor(() => expect(container.querySelector('#login-title')).not.toBeNull());
    await act(async () => secondStale.resolve(withOverview(true)));
    expect(container.querySelector('[data-router]')).toBeNull();
  });

  it('lets an Overview 404 force one revalidation despite the throttle, but never overlap a running one', async () => {
    mocks.getCurrentUser.mockResolvedValue(withOverview(false));
    await focusWindow();
    await vi.waitFor(() => expect(mocks.getCurrentUser).toHaveBeenCalledTimes(1));

    // Inside the throttle window, a forced revalidation still goes through.
    const pending = deferred<CurrentUser | null>();
    mocks.getCurrentUser.mockReturnValue(pending.promise);
    await act(async () => mocks.latest.onOverviewUnavailable!());
    expect(mocks.getCurrentUser).toHaveBeenCalledTimes(2);

    // A second forced request while one is running is dropped.
    await act(async () => mocks.latest.onOverviewUnavailable!());
    expect(mocks.getCurrentUser).toHaveBeenCalledTimes(2);

    await act(async () => pending.resolve(withOverview(true)));
    await vi.waitFor(() => expect(overviewFlag()).toBe('true'));
  });
});

describe('useIdentityRevalidation (unmount and session end)', () => {
  function Harness({ sessionKey, onIdentity, load }: {
    sessionKey: string | null;
    onIdentity: (identity: CurrentUser | null) => void;
    load: () => Promise<CurrentUser | null>;
  }) {
    useIdentityRevalidation({ sessionKey, onIdentity, load });
    return null;
  }

  it('drops a response that arrives after unmount', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const pending = deferred<CurrentUser | null>();
    const onIdentity = vi.fn();
    await act(async () => root.render(<Harness sessionKey="org-1:user-1" onIdentity={onIdentity} load={() => pending.promise} />));
    await act(async () => { window.dispatchEvent(new Event('focus')); });

    await act(async () => root.unmount());
    await act(async () => pending.resolve(withOverview(true)));
    expect(onIdentity).not.toHaveBeenCalled();
  });

  it('drops a response when the session key changes (new login) before it arrives', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const pending = deferred<CurrentUser | null>();
    const onIdentity = vi.fn();
    await act(async () => root.render(<Harness sessionKey="org-1:user-1" onIdentity={onIdentity} load={() => pending.promise} />));
    await act(async () => { window.dispatchEvent(new Event('focus')); });

    await act(async () => root.render(<Harness sessionKey="org-1:user-2" onIdentity={onIdentity} load={() => pending.promise} />));
    await act(async () => pending.resolve(withOverview(true)));
    expect(onIdentity).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
