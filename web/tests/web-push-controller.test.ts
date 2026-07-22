/** @vitest-environment jsdom */
import { ApiError } from '../src/services/api';
import { describe, expect, it, vi } from 'vitest';

import { createWebPushController } from '../src/web-push/WebPushController';

const status = {
  enabled: true,
  vapidPublicKey: 'AQID',
  renewalRequired: false,
  subscription: null,
};

function browser(overrides: Record<string, unknown> = {}) {
  return {
    capability: () => 'supported' as const,
    permission: () => 'default' as const,
    isStandalone: () => false,
    requestPermission: vi.fn().mockResolvedValue('granted'),
    currentSubscription: vi.fn().mockResolvedValue(null),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    fingerprint: vi.fn(),
    ...overrides,
  };
}

function api(overrides: Record<string, unknown> = {}) {
  return {
    getStatus: vi.fn().mockResolvedValue(status),
    createSubscription: vi.fn(),
    disableSubscription: vi.fn(),
    ...overrides,
  };
}

describe('WebPushController', () => {
  it('does not touch browser capability or mutation APIs while the server feature is disabled', async () => {
    const adapter = browser();
    const service = api({ getStatus: vi.fn().mockResolvedValue({
      enabled: false, vapidPublicKey: null, renewalRequired: false, subscription: null,
    }) });
    const controller = createWebPushController({ api: service, browser: adapter, target: window });

    await controller.start('org-1:user-1');
    await controller.enable();

    expect(adapter.requestPermission).not.toHaveBeenCalled();
    expect(adapter.currentSubscription).not.toHaveBeenCalled();
    expect(adapter.subscribe).not.toHaveBeenCalled();
    expect(service.createSubscription).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ enabled: false, pending: null });
  });

  it('requests default permission only once from an explicit enable command and saves one subscription', async () => {
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/push/example', expirationTime: null,
      keys: { p256dh: 'p256dh', auth: 'auth' }, unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const adapter = browser({ subscribe: vi.fn().mockResolvedValue(subscription) });
    const service = api({
      createSubscription: vi.fn().mockResolvedValue({
        id: 'subscription-1', createdAt: '2026-07-22T10:00:00.000Z', fingerprint: 'a'.repeat(64),
      }),
      getStatus: vi.fn()
        .mockResolvedValueOnce(status)
        .mockResolvedValueOnce({ ...status, subscription: {
          id: 'subscription-1', createdAt: '2026-07-22T10:00:00.000Z', fingerprint: 'a'.repeat(64),
        } }),
    });
    const controller = createWebPushController({ api: service, browser: adapter, target: window });

    await controller.start('org-1:user-1');
    await Promise.all([controller.enable(), controller.enable()]);

    expect(adapter.requestPermission).toHaveBeenCalledTimes(1);
    expect(adapter.subscribe).toHaveBeenCalledWith('AQID');
    expect(service.createSubscription).toHaveBeenCalledTimes(1);
    expect(service.createSubscription).toHaveBeenCalledWith({
      endpoint: subscription.endpoint, expirationTime: null, keys: subscription.keys,
    });
  });

  it('explicit enable: recoverable AbortError on currentSubscription falls through once (C1)', async () => {
    const subscription = {
      endpoint: 'https://updates.push.services.mozilla.com/push/example',
      expirationTime: null,
      keys: { p256dh: 'p256dh', auth: 'auth' },
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const adapter = browser({
      permission: () => 'granted' as const,
      currentSubscription: vi.fn().mockRejectedValue(
        Object.assign(new Error('Cihaz bildirimi aboneliği alınamadı. Sayfayı yenileyip yeniden deneyin.'), {
          name: 'AbortError',
        }),
      ),
      subscribe: vi.fn().mockResolvedValue(subscription),
    });
    const bound = {
      id: 'subscription-1', createdAt: '2026-07-22T10:00:00.000Z', fingerprint: 'a'.repeat(64),
    };
    let serverHasSubscription = false;
    const service = api({
      createSubscription: vi.fn().mockImplementation(async () => {
        serverHasSubscription = true;
        return bound;
      }),
      getStatus: vi.fn().mockImplementation(async () => (
        serverHasSubscription ? { ...status, subscription: bound } : status
      )),
    });
    const controller = createWebPushController({ api: service, browser: adapter, target: window });

    await controller.start('org-1:user-1');
    expect(adapter.currentSubscription).not.toHaveBeenCalled();
    await controller.enable();

    expect(adapter.currentSubscription).toHaveBeenCalledTimes(1);
    expect(adapter.subscribe).toHaveBeenCalledTimes(1);
    expect(adapter.subscribe).toHaveBeenCalledWith('AQID');
    expect(service.createSubscription).toHaveBeenCalledTimes(1);
    expect(service.disableSubscription).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toBe('');
    expect(controller.getSnapshot().pending).toBeNull();
    expect(controller.getSnapshot().status?.subscription).toMatchObject({ id: 'subscription-1' });
  });

  it('explicit enable: non-recoverable read error does not subscribe (C2)', async () => {
    const adapter = browser({
      permission: () => 'granted' as const,
      currentSubscription: vi.fn().mockRejectedValue(
        Object.assign(new Error('Cihaz bildirimi aboneliği alınamadı. Sayfayı yenileyip yeniden deneyin.'), {
          name: 'NotAllowedError',
        }),
      ),
      subscribe: vi.fn(),
    });
    const service = api({ getStatus: vi.fn().mockResolvedValue(status) });
    const controller = createWebPushController({ api: service, browser: adapter, target: window });

    await controller.start('org-1:user-1');
    await controller.enable();

    expect(adapter.subscribe).not.toHaveBeenCalled();
    expect(service.createSubscription).not.toHaveBeenCalled();
    expect(controller.getSnapshot().pending).toBeNull();
    expect(controller.getSnapshot().error).toMatch(/aboneliği alınamadı|açılamadı/);
    expect(controller.getSnapshot().error).not.toMatch(/Error retrieving push subscription/i);
  });

  it('recovery read error never disables server or auto-subscribes (C3)', async () => {
    const serviceWorkerTarget = makeServiceWorkerTarget();
    const serverSub = {
      id: 'subscription-1',
      createdAt: '2026-07-22T10:00:00.000Z',
      fingerprint: 'a'.repeat(64),
    };
    const adapter = browser({
      permission: () => 'granted' as const,
      currentSubscription: vi.fn().mockRejectedValue(
        Object.assign(new Error('Cihaz bildirimi aboneliği alınamadı. Sayfayı yenileyip yeniden deneyin.'), {
          name: 'AbortError',
        }),
      ),
    });
    const service = api({
      getStatus: vi.fn().mockResolvedValue({ ...status, subscription: serverSub }),
    });
    const controller = createWebPushController({
      api: service, browser: adapter, target: window, serviceWorkerTarget,
    });

    await controller.start('org-1:user-1');
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    serviceWorkerTarget.dispatch({ type: 'push-subscription-changed' });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.subscribe).not.toHaveBeenCalled();
    expect(service.createSubscription).not.toHaveBeenCalled();
    expect(service.disableSubscription).not.toHaveBeenCalled();
    expect(controller.getSnapshot().pending).toBeNull();
  });

  it('recovery true-null browser subscription disables server record (C4)', async () => {
    const serverSub = {
      id: 'subscription-1',
      createdAt: '2026-07-22T10:00:00.000Z',
      fingerprint: 'a'.repeat(64),
    };
    const adapter = browser({
      permission: () => 'granted' as const,
      currentSubscription: vi.fn().mockResolvedValue(null),
    });
    const service = api({
      getStatus: vi.fn()
        .mockResolvedValueOnce({ ...status, subscription: serverSub })
        .mockResolvedValueOnce({ ...status, subscription: serverSub })
        .mockResolvedValue({ ...status, subscription: null }),
      disableSubscription: vi.fn().mockResolvedValue(undefined),
    });
    const controller = createWebPushController({ api: service, browser: adapter, target: window });

    await controller.start('org-1:user-1');
    await controller.recover();

    expect(service.disableSubscription).toHaveBeenCalledWith('subscription-1');
    expect(adapter.subscribe).not.toHaveBeenCalled();
  });

  it('explicit enable does not loop when subscribe fails after recoverable read (C5)', async () => {
    const adapter = browser({
      permission: () => 'granted' as const,
      currentSubscription: vi.fn().mockRejectedValue(
        Object.assign(new Error('Cihaz bildirimi aboneliği alınamadı. Sayfayı yenileyip yeniden deneyin.'), {
          name: 'AbortError',
        }),
      ),
      subscribe: vi.fn().mockRejectedValue(
        new Error('Cihaz bildirimi aboneliği oluşturulamadı. Sayfayı yenileyip yeniden deneyin.'),
      ),
    });
    const service = api({ getStatus: vi.fn().mockResolvedValue(status) });
    const controller = createWebPushController({ api: service, browser: adapter, target: window });

    await controller.start('org-1:user-1');
    await controller.enable();

    expect(adapter.subscribe).toHaveBeenCalledTimes(1);
    expect(service.createSubscription).not.toHaveBeenCalled();
    expect(controller.getSnapshot().pending).toBeNull();
    expect(controller.getSnapshot().error.length).toBeGreaterThan(0);
  });

  it('Chrome happy path: null currentSubscription → subscribe once → create once (C6)', async () => {
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/example',
      expirationTime: null,
      keys: { p256dh: 'p256dh', auth: 'auth' },
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const adapter = browser({
      permission: () => 'granted' as const,
      currentSubscription: vi.fn().mockResolvedValue(null),
      subscribe: vi.fn().mockResolvedValue(subscription),
    });
    const bound = {
      id: 'subscription-1', createdAt: '2026-07-22T10:00:00.000Z', fingerprint: 'a'.repeat(64),
    };
    let serverHasSubscription = false;
    const service = api({
      createSubscription: vi.fn().mockImplementation(async () => {
        serverHasSubscription = true;
        return bound;
      }),
      getStatus: vi.fn().mockImplementation(async () => (
        serverHasSubscription ? { ...status, subscription: bound } : status
      )),
    });
    const controller = createWebPushController({ api: service, browser: adapter, target: window });

    await controller.start('org-1:user-1');
    await controller.enable();

    expect(adapter.subscribe).toHaveBeenCalledTimes(1);
    expect(service.createSubscription).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().error).toBe('');
  });

  it('does not prompt denied permissions or register a subscription', async () => {
    const adapter = browser({ permission: () => 'denied' as const });
    const controller = createWebPushController({ api: api(), browser: adapter, target: window });

    await controller.start('org-1:user-1');
    await controller.enable();

    expect(adapter.requestPermission).not.toHaveBeenCalled();
    expect(adapter.currentSubscription).not.toHaveBeenCalled();
    expect(adapter.subscribe).not.toHaveBeenCalled();
    expect(controller.getSnapshot().guidance).toBe('denied');
  });

  it('keeps the application safe and shows Home Screen guidance when required browser capabilities are absent', async () => {
    const adapter = browser({
      capability: () => 'unsupported' as const,
      permission: () => 'unsupported' as const,
      isStandalone: () => false,
    });
    const controller = createWebPushController({ api: api(), browser: adapter, target: window });

    await controller.start('org-1:user-1');
    await controller.enable();

    expect(controller.getSnapshot().guidance).toBe('install-required');
    expect(adapter.requestPermission).not.toHaveBeenCalled();
    expect(adapter.currentSubscription).not.toHaveBeenCalled();
    expect(adapter.subscribe).not.toHaveBeenCalled();
  });

  it('keeps a browser subscription for an explicit server-save retry', async () => {
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/push/example', expirationTime: null,
      keys: { p256dh: 'p256dh', auth: 'auth' }, unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const adapter = browser({
      permission: () => 'granted' as const,
      currentSubscription: vi.fn().mockResolvedValue(subscription),
    });
    const service = api({
      createSubscription: vi.fn().mockRejectedValueOnce(new Error('Sunucuya ulaşılamadı.')).mockResolvedValueOnce({}),
      getStatus: vi.fn().mockResolvedValue(status),
    });
    const controller = createWebPushController({ api: service, browser: adapter, target: window });

    await controller.start('org-1:user-1');
    await controller.enable();
    await controller.enable();

    expect(adapter.subscribe).not.toHaveBeenCalled();
    expect(adapter.currentSubscription).toHaveBeenCalledTimes(2);
    expect(service.createSubscription).toHaveBeenCalledTimes(2);
  });

  it('disables the server record before best-effort local unsubscribe', async () => {
    const calls: string[] = [];
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/push/example', expirationTime: null,
      keys: { p256dh: 'p256dh', auth: 'auth' }, unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const active = { ...status, subscription: {
      id: 'subscription-1', createdAt: '2026-07-22T10:00:00.000Z', fingerprint: 'a'.repeat(64),
    } };
    const adapter = browser({ currentSubscription: vi.fn().mockImplementation(async () => {
      calls.push('browser'); return subscription;
    }), unsubscribe: vi.fn().mockImplementation(async () => { calls.push('unsubscribe'); return true; }) });
    const service = api({
      getStatus: vi.fn().mockResolvedValue(active),
      disableSubscription: vi.fn().mockImplementation(async () => { calls.push('server'); }),
    });
    const controller = createWebPushController({ api: service, browser: adapter, target: window });

    await controller.start('org-1:user-1');
    await controller.disable();

    expect(calls.slice(0, 2)).toEqual(['server', 'browser']);
    expect(calls).toContain('unsubscribe');
  });

  it('rotates once after an ownership-opaque conflict and then stops on a second conflict', async () => {
    const initial = {
      endpoint: 'https://fcm.googleapis.com/push/old', expirationTime: null,
      keys: { p256dh: 'old', auth: 'old' }, unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const rotated = {
      endpoint: 'https://fcm.googleapis.com/push/new', expirationTime: null,
      keys: { p256dh: 'new', auth: 'new' }, unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const adapter = browser({
      permission: () => 'granted' as const,
      currentSubscription: vi.fn().mockResolvedValue(initial),
      subscribe: vi.fn().mockResolvedValue(rotated),
      unsubscribe: vi.fn().mockResolvedValue(true),
    });
    const service = api({
      getStatus: vi.fn().mockResolvedValue(status),
      createSubscription: vi.fn()
        .mockRejectedValueOnce(new ApiError(409, 'PUSH_SUBSCRIPTION_CONFLICT', 'Çakışma'))
        .mockRejectedValueOnce(new ApiError(409, 'PUSH_SUBSCRIPTION_CONFLICT', 'Çakışma')),
    });
    const controller = createWebPushController({ api: service, browser: adapter, target: window });

    await controller.start('org-1:user-1');
    await controller.enable();

    expect(adapter.unsubscribe).toHaveBeenCalledWith(initial);
    expect(adapter.subscribe).toHaveBeenCalledTimes(1);
    expect(service.createSubscription).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().error).toContain('Çakışma');
  });

  it('reconciles only an active current-session record and leaves matching fingerprints unchanged', async () => {
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/push/example', expirationTime: null,
      keys: { p256dh: 'p256dh', auth: 'auth' }, unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const active = { ...status, subscription: {
      id: 'subscription-1', createdAt: '2026-07-22T10:00:00.000Z', fingerprint: 'a'.repeat(64),
    } };
    const adapter = browser({
      permission: () => 'granted' as const,
      currentSubscription: vi.fn().mockResolvedValue(subscription),
      fingerprint: vi.fn().mockResolvedValue('a'.repeat(64)),
    });
    const service = api({ getStatus: vi.fn().mockResolvedValue(active) });
    const controller = createWebPushController({ api: service, browser: adapter, target: window });

    await controller.start('org-1:user-1');
    await controller.recover();

    expect(adapter.currentSubscription).toHaveBeenCalledTimes(2);
    expect(service.createSubscription).not.toHaveBeenCalled();
    expect(service.disableSubscription).not.toHaveBeenCalled();
  });

  it('clears an active server record when the browser subscription is missing', async () => {
    const active = { ...status, subscription: {
      id: 'subscription-1', createdAt: '2026-07-22T10:00:00.000Z', fingerprint: 'a'.repeat(64),
    } };
    const adapter = browser({ permission: () => 'granted' as const, currentSubscription: vi.fn().mockResolvedValue(null) });
    const service = api({ getStatus: vi.fn().mockResolvedValue(active) });
    const controller = createWebPushController({ api: service, browser: adapter, target: window });

    await controller.start('org-1:user-1');
    await controller.recover();

    expect(service.disableSubscription).toHaveBeenCalledWith('subscription-1');
  });

  it('clears recipient-scoped state and best-effort unsubscribes locally after logout', async () => {
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/push/example', expirationTime: null,
      keys: { p256dh: 'p256dh', auth: 'auth' }, unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const adapter = browser({
      currentSubscription: vi.fn().mockResolvedValue(subscription),
      unsubscribe: vi.fn().mockResolvedValue(true),
    });
    const controller = createWebPushController({ api: api(), browser: adapter, target: window });

    await controller.start('org-1:user-1');
    await controller.clearLocalSubscription();

    expect(adapter.unsubscribe).toHaveBeenCalledWith(subscription);
    expect(controller.getSnapshot().status).toBeNull();
    await controller.recover();
    expect(adapter.currentSubscription).toHaveBeenCalledTimes(1);
  });

  it('does not auto-rotate a renewal-required subscription before an explicit command', async () => {
    const renewal = { ...status, renewalRequired: true, subscription: {
      id: 'subscription-1', createdAt: '2026-07-22T10:00:00.000Z', fingerprint: 'a'.repeat(64),
    } };
    const adapter = browser();
    const service = api({ getStatus: vi.fn().mockResolvedValue(renewal) });
    const controller = createWebPushController({ api: service, browser: adapter, target: window });

    await controller.start('org-1:user-1');
    await controller.recover();

    expect(controller.getSnapshot().guidance).toBe('renewal-required');
    expect(adapter.currentSubscription).not.toHaveBeenCalled();
    expect(adapter.subscribe).not.toHaveBeenCalled();
  });

  it('refreshes an opted-in record when a recovered browser fingerprint changes', async () => {
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/push/replaced', expirationTime: null,
      keys: { p256dh: 'new', auth: 'new' }, unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const active = { ...status, subscription: {
      id: 'subscription-1', createdAt: '2026-07-22T10:00:00.000Z', fingerprint: 'a'.repeat(64),
    } };
    const adapter = browser({
      permission: () => 'granted' as const,
      currentSubscription: vi.fn().mockResolvedValue(subscription),
      fingerprint: vi.fn().mockResolvedValue('b'.repeat(64)),
    });
    const service = api({ getStatus: vi.fn().mockResolvedValue(active) });
    const controller = createWebPushController({ api: service, browser: adapter, target: window });

    await controller.start('org-1:user-1');

    expect(service.createSubscription).toHaveBeenCalledWith({
      endpoint: subscription.endpoint, expirationTime: null, keys: subscription.keys,
    });
  });

  it('does not let a stale status response overwrite a new identity', async () => {
    let resolveFirst: ((value: typeof status) => void) | undefined;
    const service = api({
      getStatus: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
        .mockResolvedValue({ enabled: false, vapidPublicKey: null, renewalRequired: false, subscription: null }),
    });
    const controller = createWebPushController({ api: service, browser: browser(), target: window });

    const oldIdentity = controller.start('org-1:user-1');
    await controller.setIdentity('org-2:user-2');
    resolveFirst!(status);
    await oldIdentity;

    expect(controller.getSnapshot()).toMatchObject({ enabled: false, status: { enabled: false } });
  });

  function makeServiceWorkerTarget() {
    const listeners = new Set<(event: Event) => void>();
    return {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        if (type === 'message') listeners.add(listener as (event: Event) => void);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        if (type === 'message') listeners.delete(listener as (event: Event) => void);
      }),
      dispatch(data: unknown) {
        const event = new MessageEvent('message', { data });
        for (const listener of listeners) listener(event);
      },
      listenerCount: () => listeners.size,
    };
  }

  it('recovers only on the exact push-subscription-changed message', async () => {
    const serviceWorkerTarget = makeServiceWorkerTarget();
    const service = api({
      getStatus: vi.fn().mockResolvedValue({
        ...status,
        subscription: { id: 'subscription-1', createdAt: '2026-07-22T10:00:00.000Z', fingerprint: 'a'.repeat(64) },
      }),
    });
    const adapter = browser({
      permission: () => 'granted' as const,
      currentSubscription: vi.fn().mockResolvedValue({
        endpoint: 'https://fcm.googleapis.com/push/example', expirationTime: null,
        keys: { p256dh: 'p256dh', auth: 'auth' }, unsubscribe: vi.fn().mockResolvedValue(true),
      }),
      fingerprint: vi.fn().mockResolvedValue('a'.repeat(64)),
    });
    const controller = createWebPushController({
      api: service, browser: adapter, target: window, serviceWorkerTarget,
    });

    await controller.start('org-1:user-1');
    const afterStart = service.getStatus.mock.calls.length;

    for (const invalid of [
      null, undefined, 'push-subscription-changed', [], {},
      { type: 'other' },
      { type: 'push-subscription-changed', endpoint: 'x' },
      { type: 'push-subscription-changed', userId: 'u' },
      { type: 'push-subscription-changed', data: {} },
    ]) {
      serviceWorkerTarget.dispatch(invalid);
    }
    await Promise.resolve();
    expect(service.getStatus).toHaveBeenCalledTimes(afterStart);

    serviceWorkerTarget.dispatch({ type: 'push-subscription-changed' });
    await Promise.resolve();
    await Promise.resolve();
    expect(service.getStatus.mock.calls.length).toBeGreaterThan(afterStart);
  });

  it('deduplicates concurrent recovery signals including service-worker message', async () => {
    let resolveStatus: ((value: typeof status) => void) | undefined;
    const service = api({
      getStatus: vi.fn()
        .mockResolvedValueOnce(status) // setIdentity
        .mockResolvedValueOnce(status) // start → recover
        .mockImplementation(() => new Promise((resolve) => { resolveStatus = resolve; })),
    });
    const serviceWorkerTarget = makeServiceWorkerTarget();
    const controller = createWebPushController({
      api: service, browser: browser(), target: window, serviceWorkerTarget,
    });

    await controller.start('org-1:user-1');
    const afterStart = service.getStatus.mock.calls.length;

    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    serviceWorkerTarget.dispatch({ type: 'push-subscription-changed' });
    await Promise.resolve();
    expect(service.getStatus).toHaveBeenCalledTimes(afterStart + 1);

    resolveStatus!(status);
    await Promise.resolve();
    await Promise.resolve();
  });

  it('does not register a second service-worker listener for the same identity start', async () => {
    const serviceWorkerTarget = makeServiceWorkerTarget();
    const controller = createWebPushController({
      api: api(), browser: browser(), target: window, serviceWorkerTarget,
    });

    await controller.start('org-1:user-1');
    await controller.start('org-1:user-1');
    expect(serviceWorkerTarget.addEventListener).toHaveBeenCalledTimes(1);
    expect(serviceWorkerTarget.listenerCount()).toBe(1);
  });

  it('removes the service-worker listener on stop and ignores later messages', async () => {
    const serviceWorkerTarget = makeServiceWorkerTarget();
    const service = api();
    const controller = createWebPushController({
      api: service, browser: browser(), target: window, serviceWorkerTarget,
    });

    await controller.start('org-1:user-1');
    controller.stop();
    expect(serviceWorkerTarget.removeEventListener).toHaveBeenCalled();
    expect(serviceWorkerTarget.listenerCount()).toBe(0);

    const calls = service.getStatus.mock.calls.length;
    serviceWorkerTarget.dispatch({ type: 'push-subscription-changed' });
    await Promise.resolve();
    expect(service.getStatus).toHaveBeenCalledTimes(calls);
  });

  it('starts without serviceWorkerTarget and still recovers from focus', async () => {
    const service = api();
    const controller = createWebPushController({
      api: service, browser: browser(), target: window, serviceWorkerTarget: undefined,
    });

    await controller.start('org-1:user-1');
    expect(controller.getSnapshot().enabled).toBe(true);
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(service.getStatus.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('service-worker recovery does not auto-enable when server has no subscription', async () => {
    const serviceWorkerTarget = makeServiceWorkerTarget();
    const adapter = browser({ permission: () => 'granted' as const });
    const service = api({ getStatus: vi.fn().mockResolvedValue(status) });
    const controller = createWebPushController({
      api: service, browser: adapter, target: window, serviceWorkerTarget,
    });

    await controller.start('org-1:user-1');
    serviceWorkerTarget.dispatch({ type: 'push-subscription-changed' });
    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.subscribe).not.toHaveBeenCalled();
    expect(adapter.requestPermission).not.toHaveBeenCalled();
    expect(service.createSubscription).not.toHaveBeenCalled();
  });

  it('does not apply a stale recovery mutation after identity switch', async () => {
    const serviceWorkerTarget = makeServiceWorkerTarget();
    let resolveStatusA: ((value: typeof status) => void) | undefined;
    const service = api({
      getStatus: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveStatusA = resolve; }))
        .mockResolvedValue({ enabled: false, vapidPublicKey: null, renewalRequired: false, subscription: null }),
      createSubscription: vi.fn(),
      disableSubscription: vi.fn(),
    });
    const adapter = browser({
      permission: () => 'granted' as const,
      currentSubscription: vi.fn().mockResolvedValue({
        endpoint: 'https://fcm.googleapis.com/push/a', expirationTime: null,
        keys: { p256dh: 'a', auth: 'a' }, unsubscribe: vi.fn().mockResolvedValue(true),
      }),
      fingerprint: vi.fn().mockResolvedValue('b'.repeat(64)),
    });
    const controller = createWebPushController({
      api: service, browser: adapter, target: window, serviceWorkerTarget,
    });

    const startA = controller.start('org-1:user-A');
    await Promise.resolve();
    serviceWorkerTarget.dispatch({ type: 'push-subscription-changed' });
    await controller.setIdentity('org-2:user-B');
    resolveStatusA!({
      ...status,
      subscription: { id: 'sub-a', createdAt: '2026-07-22T10:00:00.000Z', fingerprint: 'a'.repeat(64) },
    });
    await startA;

    expect(service.createSubscription).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ enabled: false });
  });

  it('starts B recovery without waiting for unresolved A recovery, and stale A cannot mutate B', async () => {
    type Status = {
      enabled: true;
      vapidPublicKey: string;
      renewalRequired: false;
      subscription: { id: string; createdAt: string; fingerprint: string };
    };
    const statusGates: Array<(value: Status) => void> = [];
    const statusA: Status = {
      enabled: true,
      vapidPublicKey: 'AQID',
      renewalRequired: false,
      subscription: {
        id: 'sub-a',
        createdAt: '2026-07-22T10:00:00.000Z',
        fingerprint: 'a'.repeat(64),
      },
    };
    const statusB: Status = {
      enabled: true,
      vapidPublicKey: 'AQID',
      renewalRequired: false,
      subscription: {
        id: 'sub-b',
        createdAt: '2026-07-22T11:00:00.000Z',
        fingerprint: 'b'.repeat(64),
      },
    };
    const statusBAfter: Status = {
      ...statusB,
      subscription: { ...statusB.subscription, fingerprint: 'c'.repeat(64) },
    };

    const service = api({
      getStatus: vi.fn().mockImplementation(() =>
        new Promise<Status>((resolve) => { statusGates.push(resolve); }),
      ),
      createSubscription: vi.fn().mockResolvedValue({
        id: 'sub-b', createdAt: '2026-07-22T11:00:00.000Z', fingerprint: 'c'.repeat(64),
      }),
      disableSubscription: vi.fn(),
    });

    const adapter = browser({
      permission: () => 'granted' as const,
      currentSubscription: vi.fn().mockResolvedValue({
        endpoint: 'https://fcm.googleapis.com/push/b',
        expirationTime: null,
        keys: { p256dh: 'bp', auth: 'ba' },
        unsubscribe: vi.fn().mockResolvedValue(true),
      }),
      fingerprint: vi.fn().mockResolvedValue('c'.repeat(64)),
    });

    const controller = createWebPushController({
      api: service, browser: adapter, target: window,
    });

    const startA = controller.start('org-1:user-A');
    await vi.waitFor(() => expect(statusGates.length).toBe(1));
    // setIdentity A
    statusGates[0]!(statusA);
    // recover A hangs on second getStatus
    await vi.waitFor(() => expect(statusGates.length).toBe(2));
    const resolveStaleA = statusGates[1]!;

    // Switch to B while A recovery is still unresolved.
    const setB = controller.setIdentity('org-2:user-B');
    await vi.waitFor(() => expect(statusGates.length).toBe(3));
    statusGates[2]!(statusB);
    await setB;
    expect(controller.getSnapshot().status?.subscription?.id).toBe('sub-b');

    // B recovery must start independently (not blocked by A).
    const recoverB = controller.recover();
    await vi.waitFor(() => expect(statusGates.length).toBe(4));
    statusGates[3]!(statusB);
    // post-create refreshStatus
    await vi.waitFor(() => expect(statusGates.length).toBe(5));
    statusGates[4]!(statusBAfter);
    await recoverB;

    expect(service.createSubscription).toHaveBeenCalledTimes(1);
    expect(service.createSubscription).toHaveBeenCalledWith({
      endpoint: 'https://fcm.googleapis.com/push/b',
      expirationTime: null,
      keys: { p256dh: 'bp', auth: 'ba' },
    });
    expect(controller.getSnapshot().status?.subscription?.id).toBe('sub-b');

    // Resolve stale A recovery — must not mutate B or create/disable for A.
    const createCalls = service.createSubscription.mock.calls.length;
    const disableCalls = service.disableSubscription.mock.calls.length;
    resolveStaleA(statusA);
    await startA;
    await Promise.resolve();
    await Promise.resolve();

    expect(service.createSubscription).toHaveBeenCalledTimes(createCalls);
    expect(service.disableSubscription).toHaveBeenCalledTimes(disableCalls);
    expect(controller.getSnapshot().status?.subscription?.id).toBe('sub-b');
    expect(controller.getSnapshot().enabled).toBe(true);
  });

  it('isolates two controller profiles on separate service-worker targets', async () => {
    const targetA = makeServiceWorkerTarget();
    const targetB = makeServiceWorkerTarget();
    const apiA = api({ getStatus: vi.fn().mockResolvedValue(status) });
    const apiB = api({ getStatus: vi.fn().mockResolvedValue({
      enabled: false, vapidPublicKey: null, renewalRequired: false, subscription: null,
    }) });
    const browserA = browser();
    const browserB = browser();
    const controllerA = createWebPushController({
      api: apiA, browser: browserA, target: window, serviceWorkerTarget: targetA,
    });
    const controllerB = createWebPushController({
      api: apiB, browser: browserB, target: {
        addEventListener: () => {},
        removeEventListener: () => {},
        document: { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} },
      }, serviceWorkerTarget: targetB,
    });

    await controllerA.start('org-1:user-A');
    await controllerB.start('org-1:user-B');
    const callsA = apiA.getStatus.mock.calls.length;
    const callsB = apiB.getStatus.mock.calls.length;

    targetA.dispatch({ type: 'push-subscription-changed' });
    await new Promise((r) => setTimeout(r, 0));
    expect(apiA.getStatus.mock.calls.length).toBeGreaterThan(callsA);
    expect(apiB.getStatus).toHaveBeenCalledTimes(callsB);

    controllerA.stop();
    const afterStopA = apiA.getStatus.mock.calls.length;
    targetA.dispatch({ type: 'push-subscription-changed' });
    await new Promise((r) => setTimeout(r, 0));
    expect(apiA.getStatus).toHaveBeenCalledTimes(afterStopA);

    targetB.dispatch({ type: 'push-subscription-changed' });
    await new Promise((r) => setTimeout(r, 0));
    expect(apiB.getStatus.mock.calls.length).toBeGreaterThan(callsB);
  });

  it('ignores worker messages after clearLocalSubscription logout', async () => {
    const serviceWorkerTarget = makeServiceWorkerTarget();
    const service = api();
    const controller = createWebPushController({
      api: service, browser: browser(), target: window, serviceWorkerTarget,
    });

    await controller.start('org-1:user-1');
    await controller.clearLocalSubscription();
    const calls = service.getStatus.mock.calls.length;
    serviceWorkerTarget.dispatch({ type: 'push-subscription-changed' });
    await new Promise((r) => setTimeout(r, 0));
    expect(service.getStatus).toHaveBeenCalledTimes(calls);
    expect(controller.getSnapshot().status).toBeNull();
  });
});
