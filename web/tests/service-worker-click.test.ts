import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  createServiceWorkerHarness,
  type ServiceWorkerHarness,
  type MockWindowClient,
} from './helpers/service-worker-harness';

describe('service worker notification click', () => {
  let harness: ServiceWorkerHarness;

  beforeEach(() => {
    harness = createServiceWorkerHarness();
  });

  it('registers a notificationclick event listener', () => {
    expect(harness.listeners.has('notificationclick')).toBe(true);
  });

  it('closes the notification on click', async () => {
    const event = harness.makeNotificationClickEvent();
    await harness.fireEvent('notificationclick', event);

    expect(event.notification.close).toHaveBeenCalledTimes(1);
  });

  it('focuses an exact same-origin target client without navigating', async () => {
    const targetUrl = '/jobs/550e8400-e29b-41d4-a716-446655440000';
    const client: MockWindowClient = {
      id: 'client-1',
      url: targetUrl,
      focus: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn(),
      postMessage: vi.fn(),
    };
    harness.clients.matchAll.mockResolvedValue([client]);

    const event = harness.makeNotificationClickEvent({
      data: { notificationId: '550e8400-e29b-41d4-a716-446655440000', url: targetUrl },
    });
    await harness.fireEvent('notificationclick', event);
    await harness.settleWaitUntil();

    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(client.navigate).not.toHaveBeenCalled();
  });

  it('navigates another same-origin client when exact target is not open', async () => {
    const targetUrl = '/jobs/550e8400-e29b-41d4-a716-446655440000';
    const client: MockWindowClient = {
      id: 'client-2',
      url: '/jobs',
      focus: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn(),
    };
    harness.clients.matchAll.mockResolvedValue([client]);

    const event = harness.makeNotificationClickEvent({
      data: { notificationId: '550e8400-e29b-41d4-a716-446655440000', url: targetUrl },
    });
    await harness.fireEvent('notificationclick', event);
    await harness.settleWaitUntil();

    expect(client.navigate).toHaveBeenCalledWith(targetUrl);
    expect(client.focus).toHaveBeenCalledTimes(1);
  });

  it('opens a new window when no same-origin client exists', async () => {
    const targetUrl = '/jobs/550e8400-e29b-41d4-a716-446655440000';
    harness.clients.matchAll.mockResolvedValue([]);
    harness.clients.openWindow.mockResolvedValue(undefined);

    const event = harness.makeNotificationClickEvent({
      data: { notificationId: '550e8400-e29b-41d4-a716-446655440000', url: targetUrl },
    });
    await harness.fireEvent('notificationclick', event);
    await harness.settleWaitUntil();

    expect(harness.clients.openWindow).toHaveBeenCalledWith(targetUrl);
  });

  it('rejects non-JobCard paths and falls back to /jobs', async () => {
    harness.clients.matchAll.mockResolvedValue([]);
    harness.clients.openWindow.mockResolvedValue(undefined);

    const nonJobCardPaths = [
      '/customers/550e8400-e29b-41d4-a716-446655440000',
      '/reports/summary',
      '/settings',
    ];

    for (const url of nonJobCardPaths) {
      harness.clients.openWindow.mockReset();
      const event = harness.makeNotificationClickEvent({
        data: { notificationId: '550e8400-e29b-41d4-a716-446655440000', url },
      });
      await harness.fireEvent('notificationclick', event);
      await harness.settleWaitUntil();
      expect(harness.clients.openWindow).toHaveBeenCalledWith('/jobs');
    }
  });

  it('uses deterministic client selection among multiple exact targets', async () => {
    const targetUrl = '/jobs/550e8400-e29b-41d4-a716-446655440000';
    const clientA: MockWindowClient = {
      id: 'a',
      url: targetUrl,
      focus: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn(),
      postMessage: vi.fn(),
    };
    const clientB: MockWindowClient = {
      id: 'b',
      url: targetUrl,
      focus: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn(),
      postMessage: vi.fn(),
    };
    harness.clients.matchAll.mockResolvedValue([clientB, clientA]);

    const event = harness.makeNotificationClickEvent({
      data: { notificationId: '550e8400-e29b-41d4-a716-446655440000', url: targetUrl },
    });
    await harness.fireEvent('notificationclick', event);
    await harness.settleWaitUntil();

    const focusedClients = [clientA.focus, clientB.focus].filter((f) => f.mock.calls.length > 0);
    expect(focusedClients).toHaveLength(1);
  });

  it('falls back to /jobs when click data URL is unsafe', async () => {
    const unsafeUrls = [
      '/jobs/550e8400-e29b-41d4-a716-446655440000?x=1',
      '/jobs/550e8400-e29b-41d4-a716-446655440000#section',
      'http://evil.example.com',
      'https://evil.example.com',
      '//evil.example.com',
      'javascript:alert(1)',
      'data:text/html,<script>',
      '/jobs\\evil',
      '/jobs/%2f%2fevil',
      '/jobs/%5cevil',
    ];

    for (const url of unsafeUrls) {
      harness.clients.matchAll.mockResolvedValue([]);
      harness.clients.openWindow.mockReset();

      const event = harness.makeNotificationClickEvent({
        data: { notificationId: '550e8400-e29b-41d4-a716-446655440000', url },
      });
      await harness.fireEvent('notificationclick', event);
      await harness.settleWaitUntil();

      expect(harness.clients.openWindow).toHaveBeenCalledWith('/jobs');
    }
  });
});
