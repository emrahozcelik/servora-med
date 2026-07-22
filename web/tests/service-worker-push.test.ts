import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createServiceWorkerHarness, type ServiceWorkerHarness } from './helpers/service-worker-harness';

function validPayload(): Record<string, unknown> {
  return {
    version: 1,
    notificationId: '550e8400-e29b-41d4-a716-446655440000',
    title: 'Yeni iş atandı',
    body: 'Size yeni bir iş atandı.',
    url: '/jobs/550e8400-e29b-41d4-a716-446655440000',
  };
}

describe('service worker push', () => {
  let harness: ServiceWorkerHarness;

  beforeEach(() => {
    harness = createServiceWorkerHarness();
  });

  it('registers a push event listener', () => {
    expect(harness.listeners.has('push')).toBe(true);
  });

  it('valid V1 payload produces exactly one notification', async () => {
    const event = harness.makePushEvent(validPayload());
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.registration.showNotification).toHaveBeenCalledTimes(1);
  });

  it('passes title and body from the payload to showNotification', async () => {
    const event = harness.makePushEvent(validPayload());
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.notifications[0].title).toBe('Yeni iş atandı');
    expect(harness.notifications[0].options.body).toBe('Size yeni bir iş atandı.');
  });

  it('uses notificationId as the notification tag', async () => {
    const payload = validPayload();
    const event = harness.makePushEvent(payload);
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.notifications[0].options.tag).toBe(payload.notificationId);
  });

  it('includes icon and badge paths', async () => {
    const event = harness.makePushEvent(validPayload());
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.notifications[0].options.icon).toBe('/icons/servora-192.png');
    expect(harness.notifications[0].options.badge).toBe('/icons/notification-badge.png');
  });

  it('notification data contains only safe fields (notificationId, url)', async () => {
    const payload = validPayload();
    const event = harness.makePushEvent(payload);
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.notifications[0].options.data).toEqual({
      notificationId: payload.notificationId,
      url: payload.url,
    });
  });

  it('missing event.data produces a generic notification', async () => {
    const event = harness.makePushEvent(null);
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(harness.notifications[0].title).toBe('Servora-Med');
    expect(harness.notifications[0].options.body).toBe('Bekleyen işleriniz var.');
    expect(harness.notifications[0].options.tag).toBe('servora-med-generic');
    expect(harness.notifications[0].options.data.url).toBe('/jobs');
  });

  it('invalid JSON payload produces a generic notification', async () => {
    const event = {
      data: { text: () => 'not json' },
      waitUntil: vi.fn(),
    };
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.notifications[0].title).toBe('Servora-Med');
  });

  it('unsupported version produces a generic notification', async () => {
    const payload = { ...validPayload(), version: 2 };
    const event = harness.makePushEvent(payload);
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.notifications[0].title).toBe('Servora-Med');
  });

  it('null payload produces a generic notification', async () => {
    const event = harness.makePushEvent(null);
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.notifications[0].title).toBe('Servora-Med');
  });

  it('array payload produces a generic notification', async () => {
    const event = harness.makePushEvent([{ version: 1 }]);
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.notifications[0].title).toBe('Servora-Med');
  });

  it('missing fields produce a generic notification', async () => {
    const payload = { version: 1 };
    const event = harness.makePushEvent(payload);
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.notifications[0].title).toBe('Servora-Med');
  });

  it('extra fields beyond the V1 contract produce a generic notification', async () => {
    const payload = {
      ...validPayload(),
      customerName: 'Test',
      customerPhone: '555',
    };
    const event = harness.makePushEvent(payload);
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.notifications[0].title).toBe('Servora-Med');
  });

  it('malformed UUID produces a generic notification', async () => {
    const payload = { ...validPayload(), notificationId: 'not-a-uuid' };
    const event = harness.makePushEvent(payload);
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.notifications[0].title).toBe('Servora-Med');
  });

  it('unsafe URL produces a generic notification with /jobs fallback', async () => {
    const unsafeUrls = [
      '/jobs/550e8400-e29b-41d4-a716-446655440000?x=1',
      '/jobs/550e8400-e29b-41d4-a716-446655440000#section',
      '/jobs//evil',
      '/jobs/../secret',
      'http://evil.example.com',
      'https://evil.example.com',
      '//evil.example.com',
      'javascript:alert(1)',
      'data:text/html,<script>',
      '/jobs\\evil',
      '/jobs/%2f%2fevil',
      '/jobs/%5cevil',
      '/customers/550e8400-e29b-41d4-a716-446655440000',
      '/reports/summary',
    ];

    for (const url of unsafeUrls) {
      harness.clearNotifications();
      const payload = { ...validPayload(), url };
      const event = harness.makePushEvent(payload);
      await harness.fireEvent('push', event);
      await harness.settleWaitUntil();

      expect(harness.notifications[0].options.data.url).toBe('/jobs');
    }
  });

  it('extra sensitive fields cause generic fallback', async () => {
    const sensitiveFields = [
      'customerName', 'customerPhone', 'jobCard', 'notes', 'delivery',
      'location', 'endpoint', 'p256dh', 'auth', 'vapidPrivateKey',
    ];

    for (const field of sensitiveFields) {
      harness.clearNotifications();
      const payload = { ...validPayload(), [field]: 'sensitive-value' };
      const event = harness.makePushEvent(payload);
      await harness.fireEvent('push', event);
      await harness.settleWaitUntil();

      expect(harness.notifications[0].title).toBe('Servora-Med');
    }
  });

  it('empty title string produces generic notification', async () => {
    const payload = { ...validPayload(), title: '' };
    const event = harness.makePushEvent(payload);
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.notifications[0].title).toBe('Servora-Med');
  });

  it('empty body string produces generic notification', async () => {
    const payload = { ...validPayload(), body: '' };
    const event = harness.makePushEvent(payload);
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.notifications[0].title).toBe('Servora-Med');
  });

  it('overly long title produces generic notification', async () => {
    const payload = { ...validPayload(), title: 'a'.repeat(121) };
    const event = harness.makePushEvent(payload);
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.notifications[0].title).toBe('Servora-Med');
  });

  it('overly long body produces generic notification', async () => {
    const payload = { ...validPayload(), body: 'a'.repeat(241) };
    const event = harness.makePushEvent(payload);
    await harness.fireEvent('push', event);
    await harness.settleWaitUntil();

    expect(harness.notifications[0].title).toBe('Servora-Med');
  });
});
