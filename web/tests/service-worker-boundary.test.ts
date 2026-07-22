import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  createServiceWorkerHarness,
  type ServiceWorkerHarness,
  type MockWindowClient,
} from './helpers/service-worker-harness';

describe('service worker boundary and safety contracts', () => {
  let harness: ServiceWorkerHarness;

  beforeEach(() => {
    harness = createServiceWorkerHarness();
  });

  it('has no fetch event listener', () => {
    expect(harness.listeners.has('fetch')).toBe(false);
  });

  it('has no sync event listener', () => {
    expect(harness.listeners.has('sync')).toBe(false);
  });

  it('has no periodic sync event listener', () => {
    expect(harness.listeners.has('periodicsync')).toBe(false);
  });

  it('has install event listener', () => {
    expect(harness.listeners.has('install')).toBe(true);
  });

  it('has activate event listener', () => {
    expect(harness.listeners.has('activate')).toBe(true);
  });

  it('has pushsubscriptionchange event listener', () => {
    expect(harness.listeners.has('pushsubscriptionchange')).toBe(true);
  });

  it('install calls skipWaiting', async () => {
    const event = harness.makeExtendableEvent();
    await harness.fireEvent('install', event);
    await harness.settleWaitUntil();

    expect(harness.selfRef.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('activate calls clients.claim', async () => {
    const event = harness.makeExtendableEvent();
    await harness.fireEvent('activate', event);
    await harness.settleWaitUntil();

    expect(harness.clients.claim).toHaveBeenCalledTimes(1);
  });

  it('install does not create caches', async () => {
    const event = harness.makeExtendableEvent();
    await harness.fireEvent('install', event);
    await harness.settleWaitUntil();

    expect(harness.registration.showNotification).not.toHaveBeenCalled();
  });

  it('activate does not create or delete caches', async () => {
    const event = harness.makeExtendableEvent();
    await harness.fireEvent('activate', event);
    await harness.settleWaitUntil();

    expect(harness.registration.showNotification).not.toHaveBeenCalled();
  });
});

describe('pushsubscriptionchange contract', () => {
  let harness: ServiceWorkerHarness;

  beforeEach(() => {
    harness = createServiceWorkerHarness();
  });

  it('posts a fixed refresh signal to open same-origin clients', async () => {
    const client: MockWindowClient = {
      id: 'client-1',
      url: '/jobs',
      focus: vi.fn(),
      navigate: vi.fn(),
      postMessage: vi.fn(),
    };
    harness.clients.matchAll.mockResolvedValue([client]);

    const event = harness.makeExtendableEvent();
    await harness.fireEvent('pushsubscriptionchange', event);
    await harness.settleWaitUntil();

    expect(client.postMessage).toHaveBeenCalledWith({ type: 'push-subscription-changed' });
  });

  it('does not call fetch or showNotification in pushsubscriptionchange', async () => {
    harness.clients.matchAll.mockResolvedValue([]);

    const event = harness.makeExtendableEvent();
    await harness.fireEvent('pushsubscriptionchange', event);
    await harness.settleWaitUntil();

    expect(harness.registration.showNotification).not.toHaveBeenCalled();
  });

  it('handles pushsubscriptionchange with no open clients as a safe no-op', async () => {
    harness.clients.matchAll.mockResolvedValue([]);

    const event = harness.makeExtendableEvent();
    await harness.fireEvent('pushsubscriptionchange', event);
    await harness.settleWaitUntil();

    expect(harness.clients.matchAll).toHaveBeenCalled();
    expect(harness.clients.openWindow).not.toHaveBeenCalled();
  });
});

describe('worker source code static analysis', () => {
  const workerPath = resolve(__dirname, '../public/service-worker.js');
  const source = readFileSync(workerPath, 'utf-8');

  it('does not contain addEventListener("fetch") or fetch(', () => {
    const lines = source.split('\n');
    const fetchListener = lines.some(
      (l) => l.includes('addEventListener(') && l.includes('fetch'),
    );
    expect(fetchListener).toBe(false);
  });

  it('does not contain CacheStorage or caches', () => {
    expect(source.includes('caches')).toBe(false);
    expect(source.includes('CacheStorage')).toBe(false);
  });

  it('does not contain IndexedDB', () => {
    expect(source.includes('indexedDB')).toBe(false);
    expect(source.includes('IndexedDB')).toBe(false);
  });

  it('does not contain sync or periodicSync event registration', () => {
    const syncListener = /addEventListener\s*\(\s*['"]sync['"]\s*,/;
    const periodicListener = /addEventListener\s*\(\s*['"]periodicsync['"]\s*,/i;
    expect(syncListener.test(source)).toBe(false);
    expect(periodicListener.test(source)).toBe(false);
  });

  it('does not contain geolocation', () => {
    expect(source.includes('geolocation')).toBe(false);
  });

  it('does not contain localStorage', () => {
    expect(source.includes('localStorage')).toBe(false);
  });

  it('does not call fetch or contain mark-read notification endpoints', () => {
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\/api\/notifications/);
    expect(source).not.toMatch(/markNotificationRead|mark-read|mark_read/i);
    expect(source).not.toMatch(/notification\.read-from-push|web-push\.delivered|push\.received/);
  });
});

describe('notificationclick has no mark-read side effects', () => {
  let harness: ServiceWorkerHarness;

  beforeEach(() => {
    harness = createServiceWorkerHarness();
  });

  it('focuses the job route without postMessage mark-read or extra network hooks', async () => {
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
      data: {
        notificationId: '550e8400-e29b-41d4-a716-446655440000',
        url: targetUrl,
      },
    });
    await harness.fireEvent('notificationclick', event);
    await harness.settleWaitUntil();

    expect(event.notification.close).toHaveBeenCalledTimes(1);
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(client.navigate).not.toHaveBeenCalled();
    expect(client.postMessage).not.toHaveBeenCalled();
    expect(harness.clients.openWindow).not.toHaveBeenCalled();
  });
});
