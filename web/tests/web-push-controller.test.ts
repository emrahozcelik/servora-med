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
});
