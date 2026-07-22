/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applicationServerKeyFromVapid,
  createBrowserWebPushAdapter,
  decodeWebPushVapidKey,
  isRecoverableSubscriptionReadError,
  SERVICE_WORKER_READY_TIMEOUT_MESSAGE,
  SERVICE_WORKER_READY_TIMEOUT_MS,
  SUBSCRIPTION_CREATE_ERROR_MESSAGE,
  SUBSCRIPTION_READ_ERROR_MESSAGE,
} from '../src/web-push/BrowserWebPushAdapter';

function makeEnv(serviceWorker: {
  register: ReturnType<typeof vi.fn>;
  ready: Promise<unknown>;
}) {
  return {
    Notification: { permission: 'granted' as NotificationPermission, requestPermission: vi.fn() },
    PushManager: function PushManager() {},
    navigator: { serviceWorker, standalone: false },
    matchMedia: () => ({ matches: false }),
  };
}

describe('BrowserWebPushAdapter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports unsupported capability without throwing when browser APIs are absent', () => {
    const adapter = createBrowserWebPushAdapter({
      Notification: undefined,
      PushManager: undefined,
      navigator: { serviceWorker: undefined, standalone: false },
      matchMedia: () => ({ matches: false }),
    });

    expect(adapter.capability()).toBe('unsupported');
    expect(adapter.permission()).toBe('unsupported');
  });

  it.each([
    ['service worker', { Notification: { permission: 'granted', requestPermission: vi.fn() }, PushManager: function PushManager() {}, navigator: { standalone: false } }],
    ['PushManager', { Notification: { permission: 'granted', requestPermission: vi.fn() }, navigator: { serviceWorker: { register: vi.fn(), ready: Promise.resolve({ pushManager: {} }) }, standalone: false } }],
    ['Notification API', { PushManager: function PushManager() {}, navigator: { serviceWorker: { register: vi.fn(), ready: Promise.resolve({ pushManager: {} }) }, standalone: false } }],
  ])('treats a missing %s capability as unsupported', (_missing, environment) => {
    const adapter = createBrowserWebPushAdapter({ ...environment, matchMedia: () => ({ matches: false }) });

    expect(adapter.capability()).toBe('unsupported');
  });

  it('registers the fixed worker and subscribes with the decoded server VAPID key', async () => {
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/push/example',
      expirationTime: null,
      toJSON: () => ({
        endpoint: 'https://fcm.googleapis.com/push/example',
        expirationTime: null,
        keys: { p256dh: 'public-key', auth: 'auth-key' },
      }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const subscribe = vi.fn().mockResolvedValue(subscription);
    const registration = { pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe } };
    const register = vi.fn().mockResolvedValue(registration);
    const adapter = createBrowserWebPushAdapter(makeEnv({
      register,
      ready: Promise.resolve(registration),
    }));

    const created = await adapter.subscribe('AQID');

    expect(register).toHaveBeenCalledWith('/service-worker.js', {
      scope: '/', updateViaCache: 'none',
    });
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]),
    });
    expect(created).toMatchObject({
      endpoint: 'https://fcm.googleapis.com/push/example',
      keys: { p256dh: 'public-key', auth: 'auth-key' },
    });
  });

  it('waits for ready before calling getSubscription (A1)', async () => {
    const getSubscription = vi.fn().mockResolvedValue(null);
    let resolveReady: ((value: { pushManager: { getSubscription: typeof getSubscription; subscribe: ReturnType<typeof vi.fn> } }) => void) | undefined;
    const readyRegistration = { pushManager: { getSubscription, subscribe: vi.fn() } };
    const adapter = createBrowserWebPushAdapter(
      makeEnv({
        register: vi.fn().mockResolvedValue({
          pushManager: { getSubscription: vi.fn(), subscribe: vi.fn() },
        }),
        ready: new Promise((resolve) => {
          resolveReady = resolve;
        }),
      }),
      { readyTimeoutMs: 5_000 },
    );

    const pending = adapter.currentSubscription();
    await Promise.resolve();
    expect(getSubscription).not.toHaveBeenCalled();

    resolveReady!(readyRegistration);
    await expect(pending).resolves.toBeNull();
    expect(getSubscription).toHaveBeenCalledTimes(1);
  });

  it('waits for ready before calling subscribe (A2)', async () => {
    const subscribe = vi.fn().mockResolvedValue({
      endpoint: 'https://example.test/push',
      expirationTime: null,
      toJSON: () => ({
        endpoint: 'https://example.test/push',
        expirationTime: null,
        keys: { p256dh: 'p', auth: 'a' },
      }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    });
    let resolveReady: ((value: { pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: typeof subscribe } }) => void) | undefined;
    const readyRegistration = { pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe } };
    const adapter = createBrowserWebPushAdapter(
      makeEnv({
        register: vi.fn().mockResolvedValue({
          pushManager: { getSubscription: vi.fn(), subscribe: vi.fn() },
        }),
        ready: new Promise((resolve) => {
          resolveReady = resolve;
        }),
      }),
      { readyTimeoutMs: 5_000 },
    );

    const pending = adapter.subscribe('AQID');
    await Promise.resolve();
    expect(subscribe).not.toHaveBeenCalled();

    resolveReady!(readyRegistration);
    await expect(pending).resolves.toMatchObject({ endpoint: 'https://example.test/push' });
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('times out ready with Turkish message and never calls getSubscription (A3)', async () => {
    vi.useFakeTimers();
    const getSubscription = vi.fn();
    const adapter = createBrowserWebPushAdapter(
      makeEnv({
        register: vi.fn().mockResolvedValue({
          pushManager: { getSubscription, subscribe: vi.fn() },
        }),
        ready: new Promise(() => {}),
      }),
      { readyTimeoutMs: 10_000 },
    );

    const pending = expect(adapter.currentSubscription()).rejects.toThrow(
      SERVICE_WORKER_READY_TIMEOUT_MESSAGE,
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(getSubscription).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(getSubscription).not.toHaveBeenCalled();
  });

  it('ignores late ready after timeout so it cannot start mutation (A4)', async () => {
    vi.useFakeTimers();
    let resolveReady: ((value: { pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> } }) => void) | undefined;
    const getSubscription = vi.fn().mockResolvedValue(null);
    const subscribe = vi.fn();
    const lateRegistration = { pushManager: { getSubscription, subscribe } };
    const adapter = createBrowserWebPushAdapter(
      makeEnv({
        register: vi.fn().mockResolvedValue({
          pushManager: { getSubscription: vi.fn(), subscribe: vi.fn() },
        }),
        ready: new Promise((resolve) => {
          resolveReady = resolve;
        }),
      }),
      { readyTimeoutMs: 50 },
    );

    const pending = expect(adapter.currentSubscription()).rejects.toThrow(
      SERVICE_WORKER_READY_TIMEOUT_MESSAGE,
    );
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    resolveReady!(lateRegistration);
    await Promise.resolve();
    await Promise.resolve();
    expect(getSubscription).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('uses a clean Uint8Array VAPID key copy (A5)', () => {
    const key = applicationServerKeyFromVapid('AQID');
    expect(key).toBeInstanceOf(Uint8Array);
    expect(Array.from(key)).toEqual([1, 2, 3]);
    expect(key.buffer.byteLength).toBe(3);
    expect(key.byteOffset).toBe(0);
  });

  it.each([
    [
      'AbortError on getSubscription',
      async (adapter: ReturnType<typeof createBrowserWebPushAdapter>) => adapter.currentSubscription(),
      () => Object.assign(new Error('Error retrieving push subscription.'), { name: 'AbortError' }),
      SUBSCRIPTION_READ_ERROR_MESSAGE,
      'AbortError',
    ],
    [
      'InvalidStateError on getSubscription',
      async (adapter: ReturnType<typeof createBrowserWebPushAdapter>) => adapter.currentSubscription(),
      () => Object.assign(new Error('InvalidStateError'), { name: 'InvalidStateError' }),
      SUBSCRIPTION_READ_ERROR_MESSAGE,
      'InvalidStateError',
    ],
    [
      'generic getSubscription error',
      async (adapter: ReturnType<typeof createBrowserWebPushAdapter>) => adapter.currentSubscription(),
      () => new Error('Error retrieving push subscription.'),
      SUBSCRIPTION_READ_ERROR_MESSAGE,
      'Error',
    ],
    [
      'subscribe AbortError',
      async (adapter: ReturnType<typeof createBrowserWebPushAdapter>) => adapter.subscribe('AQID'),
      () => Object.assign(new Error('Error retrieving push subscription.'), { name: 'AbortError' }),
      SUBSCRIPTION_CREATE_ERROR_MESSAGE,
      'AbortError',
      true,
    ],
  ] as const)('normalizes %s without native English UI text (A6)', async (
    _label,
    invoke,
    makeError,
    expectedMessage,
    expectedName,
    isSubscribe = false,
  ) => {
    const failing = isSubscribe
      ? { getSubscription: vi.fn().mockResolvedValue(null), subscribe: vi.fn().mockRejectedValue(makeError()) }
      : { getSubscription: vi.fn().mockRejectedValue(makeError()), subscribe: vi.fn() };
    const registration = { pushManager: failing };
    const adapter = createBrowserWebPushAdapter(makeEnv({
      register: vi.fn().mockResolvedValue(registration),
      ready: Promise.resolve(registration),
    }));

    await expect(invoke(adapter)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(expectedMessage);
      expect((error as Error).message).not.toMatch(/Error retrieving push subscription/i);
      expect((error as Error).name).toBe(expectedName);
      return true;
    });
  });

  it('defaults ready timeout to 10 seconds', () => {
    expect(SERVICE_WORKER_READY_TIMEOUT_MS).toBe(10_000);
  });

  it('classifies recoverable subscription read errors', () => {
    expect(isRecoverableSubscriptionReadError(
      Object.assign(new Error(SUBSCRIPTION_READ_ERROR_MESSAGE), { name: 'AbortError' }),
    )).toBe(true);
    expect(isRecoverableSubscriptionReadError(
      Object.assign(new Error(SUBSCRIPTION_READ_ERROR_MESSAGE), { name: 'InvalidStateError' }),
    )).toBe(true);
    expect(isRecoverableSubscriptionReadError(new Error(SERVICE_WORKER_READY_TIMEOUT_MESSAGE))).toBe(false);
    expect(isRecoverableSubscriptionReadError(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    )).toBe(false);
  });

  it('decodes URL-safe Base64 VAPID key bytes', () => {
    expect(decodeWebPushVapidKey('-_8')).toEqual(new Uint8Array([251, 255]));
  });
});
