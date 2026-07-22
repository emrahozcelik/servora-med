/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

import {
  createBrowserWebPushAdapter,
  decodeWebPushVapidKey,
} from '../src/web-push/BrowserWebPushAdapter';

describe('BrowserWebPushAdapter', () => {
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
    ['PushManager', { Notification: { permission: 'granted', requestPermission: vi.fn() }, navigator: { serviceWorker: { register: vi.fn() }, standalone: false } }],
    ['Notification API', { PushManager: function PushManager() {}, navigator: { serviceWorker: { register: vi.fn() }, standalone: false } }],
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
    const adapter = createBrowserWebPushAdapter({
      Notification: { permission: 'granted', requestPermission: vi.fn() },
      PushManager: function PushManager() {},
      navigator: { serviceWorker: { register }, standalone: false },
      matchMedia: () => ({ matches: false }),
    });

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

  it('decodes URL-safe Base64 VAPID key bytes', () => {
    expect(decodeWebPushVapidKey('-_8')).toEqual(new Uint8Array([251, 255]));
  });
});
