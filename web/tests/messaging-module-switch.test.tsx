/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jobsMounts: 0,
  listConversations: vi.fn(),
  listMessages: vi.fn(),
  getUnreadCount: vi.fn(),
  sendMessage: vi.fn(),
  getCurrentUser: vi.fn(),
  realtimeCallbacks: new Map<string, () => void>(),
}));

vi.mock('../src/jobs/JobWorkspace', async () => {
  const { useEffect } = await import('react');
  return {
    JobWorkspace: () => {
      useEffect(() => { mocks.jobsMounts += 1; }, []);
      return <div data-page="jobs" />;
    },
  };
});

vi.mock('../src/services/messaging-api', async () => {
  const actual = await vi.importActual<typeof import('../src/services/messaging-api')>('../src/services/messaging-api');
  return {
    ...actual,
    listConversations: (...args: unknown[]) => mocks.listConversations(...args),
    listMessages: (...args: unknown[]) => mocks.listMessages(...args),
    getUnreadCount: (...args: unknown[]) => mocks.getUnreadCount(...args),
    sendMessage: (...args: unknown[]) => mocks.sendMessage(...args),
    listRecipients: vi.fn().mockResolvedValue([]),
    markRead: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../src/services/notifications-api', () => ({
  markNotificationsReadByEntity: vi.fn().mockResolvedValue(undefined),
  listNotifications: vi.fn().mockResolvedValue({ items: [], nextCursor: null, unreadCount: 0 }),
  getUnreadNotificationCount: vi.fn().mockResolvedValue(0),
}));

vi.mock('../src/realtime/RealtimeProvider', async () => {
  const actual = await vi.importActual<typeof import('../src/realtime/RealtimeProvider')>('../src/realtime/RealtimeProvider');
  return {
    ...actual,
    RealtimeProvider: ({ children }: { children: unknown }) => children,
    useRealtimeInvalidation: (keys: string[], cb: () => void) => {
      for (const key of keys) mocks.realtimeCallbacks.set(key, cb);
      return () => { for (const key of keys) mocks.realtimeCallbacks.delete(key); };
    },
  };
});

import { App } from '../src/App';
import { AppRouter } from '../src/AppRouter';
import { MessagingPage } from '../src/messaging/MessagingPage';
import { OperatorModulesPage } from '../src/operator/OperatorModulesPage';
import { buildNavigationModel } from '../src/shell/navigation-model';
import { ApiError, type CurrentUser } from '../src/services/api';
import { ServoraAntProvider } from '../src/ui/antd/ServoraAntProvider';
import { stubDesktopMatchMedia } from './antd-match-media';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const makeUser = (messaging: boolean): CurrentUser => ({
  id: 'manager-1',
  organizationId: 'org-1',
  name: 'Murat Yönetici',
  email: 'manager@example.com',
  role: 'MANAGER',
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
});

function conv(id: string, name = 'Ayşe Personel') {
  return {
    id,
    directKey: `a:${id}:GENERAL`,
    contextType: 'GENERAL' as const,
    jobId: null,
    jobTitle: null,
    customerId: null,
    customerName: null,
    title: null,
    participantName: name,
    participantId: 'staff-1',
    participantIsActive: true,
    participants: [
      { userId: 'manager-1', name: 'Murat Yönetici', isActive: true },
      { userId: 'staff-1', name, isActive: true },
    ],
    unreadCount: 0,
    lastActivityAt: '2026-11-26T09:00:00.000Z',
    updatedAt: '2026-11-26T09:00:00.000Z',
  };
}

function msg(id: string, body: string) {
  return {
    id,
    conversationId: 'c1',
    organizationId: 'org-1',
    senderUserId: 'staff-1',
    senderName: 'Ayşe Personel',
    clientActionId: `ca-${id}`,
    body,
    createdAt: '2026-11-26T09:05:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function LocationProbe() {
  const { pathname } = useLocation();
  return <output data-location>{pathname}</output>;
}

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeAll(() => {
  stubDesktopMatchMedia();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  mocks.jobsMounts = 0;
  mocks.listConversations.mockReset();
  mocks.listMessages.mockReset();
  mocks.getUnreadCount.mockReset();
  mocks.sendMessage.mockReset();
  mocks.getCurrentUser.mockReset();
  mocks.realtimeCallbacks.clear();
  mocks.getUnreadCount.mockResolvedValue(0);
});

describe('Messaging module switching in the customer router (MSG-001 S8)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.listConversations.mockResolvedValue({ items: [], nextCursor: null });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderRouter(path: string, user: CurrentUser, onModuleUnavailable?: () => void) {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <LocationProbe />
          <AppRouter
            user={user}
            notice=""
            onDeliveryCreated={() => {}}
            onSessionEnded={() => {}}
            onModuleUnavailable={onModuleUnavailable}
          />
        </MemoryRouter>,
      );
    });
    await act(async () => { await vi.dynamicImportSettled(); });
  }

  const location = () => container.querySelector('[data-location]')?.textContent;

  it('moves an open /messages page to /jobs when messaging capability turns off', async () => {
    await renderRouter('/messages', makeUser(true));
    await flush();
    expect(location()).toBe('/messages');
    expect(container.textContent).toContain('Konuşma bulunmuyor');

    await renderRouter('/messages', makeUser(false));
    await vi.waitFor(() => expect(location()).toBe('/jobs'));
    expect(container.querySelector('[data-page="jobs"]')).not.toBeNull();
  });

  it('does not interrupt /jobs when messaging capability turns on and updates navigation', async () => {
    await renderRouter('/jobs', makeUser(false));
    expect(mocks.jobsMounts).toBe(1);

    await renderRouter('/jobs', makeUser(true));
    expect(location()).toBe('/jobs');
    expect(mocks.jobsMounts).toBe(1);

    expect(buildNavigationModel(makeUser(false)).destinations.some((item) => item.id === 'messages')).toBe(false);
    expect(buildNavigationModel(makeUser(true)).destinations.some((item) => item.id === 'messages')).toBe(true);
  });

  it('forwards onModuleUnavailable through AppRouter to MessagingPage and exits /messages on 404 after revalidation', async () => {
    const api = await import('../src/services/api');
    const fetchSpy = vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve(new Response(JSON.stringify({ user: makeUser(false) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchSpy);
    mocks.listConversations.mockRejectedValue(new api.ApiError(404, 'NOT_FOUND', 'Sayfa bulunamadı.'));

    try {
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={['/messages']}>
            <LocationProbe />
            <App initialUser={makeUser(true)} />
          </MemoryRouter>,
        );
      });
      await act(async () => { await vi.dynamicImportSettled(); });
      await flush(50);

      await vi.waitFor(() => expect(location()).toBe('/jobs'));
      expect(container.querySelector('[data-page="jobs"]')).not.toBeNull();
      const meCalls = fetchSpy.mock.calls.filter(([url]) => url === '/api/auth/me');
      expect(meCalls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('MessagingPage 404 -> onUnavailable once, no loop', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function mountMessaging(onUnavailable: () => void, user: CurrentUser = makeUser(true)) {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/messages']}>
          <MessagingPage user={user} onUnavailable={onUnavailable} />
        </MemoryRouter>,
      );
    });
    await flush();
  }

  it('calls onUnavailable once and does not loop on conversation list load 404', async () => {
    const onUnavailable = vi.fn();
    mocks.listConversations.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Sayfa bulunamadı.'));

    await mountMessaging(onUnavailable);
    await flush(50);

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(mocks.listConversations).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Konuşmalar yüklenemedi');

    // Even if the parent re-renders with a fresh inline callback while still on /messages,
    // list loading must not re-fire or loop.
    await mountMessaging(() => onUnavailable(), { ...makeUser(true) });
    await flush(50);

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(mocks.listConversations).toHaveBeenCalledTimes(1);
  });

  it('calls onUnavailable once on thread load 404 while preserving M9 removal cleanup', async () => {
    const onUnavailable = vi.fn();
    mocks.listConversations.mockResolvedValue({ items: [conv('c1')], nextCursor: null });
    mocks.listMessages.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Sayfa bulunamadı.'));

    await mountMessaging(onUnavailable);
    const convBtn = container.querySelector('.conversation-item') as HTMLButtonElement;
    expect(convBtn).not.toBeNull();

    await act(async () => { convBtn.click(); });
    await flush(50);

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(mocks.listMessages).toHaveBeenCalledTimes(1);
    // M9 behavior preserved: thread selection clears without showing threadError.
    expect(container.querySelector('.messaging-thread.active')).toBeNull();
    expect(container.querySelector('.inline-error')).toBeNull();
  });

  it('calls onUnavailable once on older thread page load 404 without looping', async () => {
    const onUnavailable = vi.fn();
    mocks.listConversations.mockResolvedValue({ items: [conv('c1')], nextCursor: null });
    mocks.listMessages
      .mockResolvedValueOnce({ items: [msg('m1', 'Merhaba')], nextCursor: 'cursor-1' })
      .mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Sayfa bulunamadı.'));

    await mountMessaging(onUnavailable);
    await act(async () => { container.querySelector<HTMLButtonElement>('.conversation-item')!.click(); });
    await flush();

    const olderBtn = container.querySelector<HTMLButtonElement>('.older-messages-control button')!;
    expect(olderBtn).not.toBeNull();
    await act(async () => { olderBtn.click(); });
    await flush(50);

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(mocks.listMessages).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Sayfa bulunamadı.');
  });

  it('calls onUnavailable once on send 404 while preserving send error state', async () => {
    const onUnavailable = vi.fn();
    mocks.listConversations.mockResolvedValue({ items: [conv('c1')], nextCursor: null });
    mocks.listMessages.mockResolvedValue({ items: [msg('m1', 'Merhaba')], nextCursor: null });
    mocks.sendMessage.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Sayfa bulunamadı.'));

    await mountMessaging(onUnavailable);
    await act(async () => { container.querySelector<HTMLButtonElement>('.conversation-item')!.click(); });
    await flush();

    const textarea = container.querySelector('.composer-input') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(textarea, 'Selam');
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('.send-button')!.click(); });
    await flush(50);

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.thread-composer .inline-error')?.textContent).toContain('Sayfa bulunamadı.');
  });

  it('does not call onUnavailable on 403, 503, or network failures', async () => {
    const onUnavailable = vi.fn();

    // List 503
    mocks.listConversations.mockRejectedValueOnce(new ApiError(503, 'MODULE_STATE_UNAVAILABLE', 'Okunamıyor.', true));
    await mountMessaging(onUnavailable);
    expect(onUnavailable).not.toHaveBeenCalled();

    // Thread 403
    mocks.listConversations.mockResolvedValue({ items: [conv('c1')], nextCursor: null });
    mocks.listMessages.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Yetki yok.'));
    await act(async () => { container.querySelector<HTMLButtonElement>('button')?.click(); });
    await flush();
    await act(async () => { container.querySelector<HTMLButtonElement>('.conversation-item')!.click(); });
    await flush();
    expect(onUnavailable).not.toHaveBeenCalled();

    // Send network error
    mocks.listMessages.mockResolvedValueOnce({ items: [msg('m1', 'Merhaba')], nextCursor: null });
    mocks.sendMessage.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'Bağlantı yok.', true));
    await act(async () => { container.querySelector<HTMLButtonElement>('.conversation-item')!.click(); });
    await flush();
    const textarea = container.querySelector('.composer-input') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(textarea, 'Deneme');
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('.send-button')!.click(); });
    await flush();
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('does not call onUnavailable for a stale thread load 404 after switching conversations or unmounting', async () => {
    const onUnavailable = vi.fn();
    mocks.listConversations.mockResolvedValue({ items: [conv('c1'), conv('c2')], nextCursor: null });

    const loadC1 = deferred<never>();
    const loadC2 = deferred<{ items: ReturnType<typeof msg>[]; nextCursor: null }>();
    mocks.listMessages
      .mockImplementationOnce(() => loadC1.promise)
      .mockImplementationOnce(() => loadC2.promise);

    await mountMessaging(onUnavailable);
    const buttons = container.querySelectorAll<HTMLButtonElement>('.conversation-item');
    await act(async () => { buttons[0]!.click(); });
    await act(async () => { buttons[1]!.click(); });
    await act(async () => { loadC2.resolve({ items: [msg('m2', 'B')], nextCursor: null }); });
    await flush();

    // Stale 404 from c1 must stay inert.
    await act(async () => { loadC1.reject(new ApiError(404, 'NOT_FOUND', 'Sayfa bulunamadı.')); });
    await flush();
    expect(onUnavailable).not.toHaveBeenCalled();

    // List load 404 settling after unmount must stay inert.
    const pendingList = deferred<never>();
    mocks.listConversations.mockImplementationOnce(() => pendingList.promise);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/messages']}>
          <MessagingPage key="remount" user={makeUser(true)} onUnavailable={onUnavailable} />
        </MemoryRouter>,
      );
    });
    await act(async () => { root.unmount(); });
    await act(async () => { pendingList.reject(new ApiError(404, 'NOT_FOUND', 'Sayfa bulunamadı.')); });
    await flush();
    expect(onUnavailable).not.toHaveBeenCalled();
  });
});

describe('OperatorModulesPage renders MESSAGING R0 descriptor copy (MSG-001 S8)', () => {
  it('renders the MESSAGING row and confirmation lists without changes to OperatorModulesPage', async () => {
    const messagingModule = {
      key: 'MESSAGING',
      label: 'Mesajlaşma',
      description: 'İş ve konu merkezli kurum içi iletişim.',
      enabled: true,
      version: 2,
      source: 'ENV_TAKEOVER' as const,
      updatedAt: '2026-11-26T09:30:00.000Z',
      whenDisabled: [
        'Mesajlar menüsü ve sayfası',
        'Mesajlaşma API erişimi',
        'İş detayından mesajlaşma',
        'Mesaj bildirimleri ve mesaj Web Push teslimatı',
        'Okunmamış mesaj sayacı',
      ],
      preserved: [
        'Konuşmalar ve mesaj geçmişi',
        'Arşiv ve audit kayıtları',
        'Personel devir ve offboarding işlemleri',
      ],
    };

    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/operator/modules') {
        return Promise.resolve(new Response(JSON.stringify({ modules: [messagingModule] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ServoraAntProvider>
            <OperatorModulesPage
              operator={{
                id: 'op-1',
                name: 'Kurulum Operatörü',
                email: 'operator@example.com',
                capabilities: ['MODULE_MANAGEMENT'],
              }}
              onSessionEnded={() => {}}
              onSignedOut={() => {}}
            />
          </ServoraAntProvider>,
        );
      });

      await vi.waitFor(() => expect(container.querySelector('button[role="switch"]')).not.toBeNull());
      expect(container.textContent).toContain('Mesajlaşma');
      expect(container.textContent).toContain(messagingModule.description);

      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[role="switch"]')!.click();
      });

      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain('Mesajlaşma modülü kapatılsın mı?');
      expect(dialog?.textContent).toContain('Kapanacaklar:');
      expect(dialog?.textContent).toContain('Korunanlar:');
      const lists = Array.from(dialog?.querySelectorAll('[role="list"]') ?? []);
      expect(lists).toHaveLength(2);
      expect(Array.from(lists[0]!.querySelectorAll('[role="listitem"]')).map((item) => item.textContent))
        .toEqual(messagingModule.whenDisabled);
      expect(Array.from(lists[1]!.querySelectorAll('[role="listitem"]')).map((item) => item.textContent))
        .toEqual(messagingModule.preserved);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
