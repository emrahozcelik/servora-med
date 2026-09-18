import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWebPushSubscription,
  disableWebPushSubscription,
  getWebPushStatus,
  parseCreateWebPushSubscriptionRequest,
  parseWebPushStatus,
  reconcileMissingWebPushSubscription,
  recoverWebPushSubscription,
} from '../src/services/web-push-api';

afterEach(() => vi.unstubAllGlobals());

const publicSubscription = {
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-07-22T08:00:00.000Z',
  fingerprint: 'a'.repeat(64),
};

describe('Web Push API adapter', () => {
  it('strictly parses status without accepting capability material', () => {
    expect(parseWebPushStatus({
      enabled: true,
      vapidPublicKey: 'public-vapid-key',
      renewalRequired: false,
      subscription: publicSubscription,
    })).toEqual({
      enabled: true,
      vapidPublicKey: 'public-vapid-key',
      renewalRequired: false,
      subscription: publicSubscription,
    });
    expect(() => parseWebPushStatus({
      enabled: true,
      vapidPublicKey: 'public-vapid-key',
      renewalRequired: false,
      subscription: { ...publicSubscription, endpoint: 'private-endpoint' },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });

  it('loads status, creates exact subscription JSON, and disables by ID', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        enabled: false,
        vapidPublicKey: null,
        renewalRequired: false,
        subscription: null,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(publicSubscription), {
        status: 201, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const input = {
      endpoint: 'https://fcm.googleapis.com/push/example',
      expirationTime: null,
      keys: { p256dh: 'public-key', auth: 'auth-key' },
    };

    await expect(getWebPushStatus()).resolves.toMatchObject({ enabled: false });
    await expect(createWebPushSubscription(input)).resolves.toEqual(publicSubscription);
    await expect(disableWebPushSubscription(publicSubscription.id)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/web-push/subscriptions',
      expect.objectContaining({ method: 'POST', credentials: 'include' }));
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual(input);
    expect(fetchMock).toHaveBeenNthCalledWith(3,
      `/api/web-push/subscriptions/${publicSubscription.id}`,
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }));
  });

  it('rejects unknown or malformed outgoing subscription fields', () => {
    expect(() => parseCreateWebPushSubscriptionRequest({
      endpoint: 'https://fcm.googleapis.com/push/example',
      expirationTime: null,
      keys: { p256dh: 'public-key', auth: 'auth-key' },
      unexpected: true,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => parseCreateWebPushSubscriptionRequest({
      endpoint: 'https://fcm.googleapis.com/push/example',
      expirationTime: -1,
      keys: { p256dh: 'public-key', auth: 'auth-key' },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('recovers an existing subscription without exposing ownership details', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ rebound: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rebound: false, owner: 'hidden' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const input = {
      endpoint: 'https://fcm.googleapis.com/push/example',
      expirationTime: null,
      keys: { p256dh: 'public-key', auth: 'auth-key' },
    };

    await expect(recoverWebPushSubscription(input)).resolves.toEqual({ rebound: true });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/web-push/subscriptions/recover',
      expect.objectContaining({ method: 'POST', credentials: 'include' }));
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual(input);
    await expect(recoverWebPushSubscription(input))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('reconciles a missing browser subscription separately from explicit disable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reconcileMissingWebPushSubscription(publicSubscription.id))
      .resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/web-push/subscriptions/${publicSubscription.id}/reconcile-missing`,
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });
});
