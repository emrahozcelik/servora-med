import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import { vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type MockWindowClient = {
  id: string;
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
};

export type MockClients = {
  matchAll: ReturnType<typeof vi.fn>;
  openWindow: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
};

export type NotificationCall = {
  title: string;
  options: Record<string, unknown>;
};

export type ServiceWorkerHarness = {
  notifications: NotificationCall[];
  listeners: Map<string, Array<(event: Record<string, unknown>) => Promise<void> | void>>;
  clients: MockClients;
  registration: {
    showNotification: ReturnType<typeof vi.fn>;
  };
  selfRef: Record<string, unknown>;
  fireEvent: (eventName: string, event: Record<string, unknown>) => Promise<void>;
  makePushEvent: (data: unknown) => Record<string, unknown>;
  makeNotificationClickEvent: (overrides?: Record<string, unknown>) => Record<string, unknown>;
  makeExtendableEvent: () => Record<string, unknown>;
  settleWaitUntil: () => Promise<void>;
  clearNotifications: () => void;
};

export function createServiceWorkerHarness(): ServiceWorkerHarness {
  const workerPath = resolve(__dirname, '../../public/service-worker.js');
  const workerSource = readFileSync(workerPath, 'utf-8');

  const listeners = new Map<string, Array<(event: Record<string, unknown>) => Promise<void> | void>>();
  const pendingWaitUntil: Array<Promise<unknown>> = [];
  const notifications: NotificationCall[] = [];

  const clients: MockClients = {
    matchAll: vi.fn().mockResolvedValue([]),
    openWindow: vi.fn(),
    claim: vi.fn().mockResolvedValue(undefined),
  };

  const registration = {
    showNotification: vi.fn().mockImplementation((title: string, options: Record<string, unknown>) => {
      notifications.push({ title, options: { ...options } });
      return Promise.resolve();
    }),
  };

  const selfRef: Record<string, unknown> = {
    addEventListener: vi.fn((event: string, handler: (event: Record<string, unknown>) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    }),
    skipWaiting: vi.fn(),
    clients,
    registration,
  };

  const sandbox = { self: selfRef, console };
  vm.createContext(sandbox);
  vm.runInContext(workerSource, sandbox);

  const captureWaitUntil = (event: Record<string, unknown>) => {
    const origWaitUntil = event.waitUntil as ((p: Promise<unknown>) => void);
    const wrapped = vi.fn((promise: Promise<unknown>) => {
      pendingWaitUntil.push(promise);
      if (origWaitUntil) origWaitUntil(promise);
    });
    event.waitUntil = wrapped;
  };

  return {
    notifications,
    listeners,
    clients,
    registration,
    selfRef,
    async fireEvent(eventName: string, event: Record<string, unknown>) {
      captureWaitUntil(event);
      const handlers = listeners.get(eventName) || [];
      for (const handler of handlers) {
        await handler(event);
      }
    },
    makePushEvent(data: unknown) {
      return {
        data: data !== undefined && data !== null
          ? { text: () => JSON.stringify(data) }
          : null,
        waitUntil: vi.fn((promise: Promise<unknown>) => {
          pendingWaitUntil.push(promise);
        }),
      };
    },
    makeNotificationClickEvent(overrides: Record<string, unknown> = {}) {
      const notification = {
        close: vi.fn(),
        data: null,
        ...overrides,
      };
      return {
        notification,
        waitUntil: vi.fn((promise: Promise<unknown>) => {
          pendingWaitUntil.push(promise);
        }),
      };
    },
    makeExtendableEvent() {
      return {
        waitUntil: vi.fn((promise: Promise<unknown>) => {
          pendingWaitUntil.push(promise);
        }),
      };
    },
    async settleWaitUntil() {
      const pending = [...pendingWaitUntil];
      pendingWaitUntil.length = 0;
      await Promise.all(pending);
    },
    clearNotifications() {
      notifications.length = 0;
    },
  };
}
