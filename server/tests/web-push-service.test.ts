import { createECDH } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  fingerprintVapidPublicKey,
  WebPushOwnershipConflictError,
} from '../src/modules/web-push/repository.js';
import { WebPushService } from '../src/modules/web-push/service.js';

const privateKey = Buffer.alloc(32, 0);
privateKey[31] = 1;
const ecdh = createECDH('prime256v1');
ecdh.setPrivateKey(privateKey);
const publicKey = ecdh.getPublicKey().toString('base64url');

const disabledConfig = {
  enabled: false,
  vapidSubject: null,
  vapidPublicKey: null,
  vapidPrivateKey: null,
} as const;
const enabledConfig = {
  enabled: true,
  vapidSubject: 'mailto:operations@example.com',
  vapidPublicKey: publicKey,
  vapidPrivateKey: privateKey.toString('base64url'),
} as const;
const identity = {
  organizationId: 'organization-1',
  userId: 'user-1',
  sessionId: 'session-1',
};
const activeSubscription = {
  id: 'subscription-1',
  organizationId: identity.organizationId,
  recipientUserId: identity.userId,
  sessionId: identity.sessionId,
  endpoint: 'https://fcm.googleapis.com/push/private-endpoint',
  endpointHash: 'a'.repeat(64),
  p256dh: 'private-p256dh',
  auth: 'private-auth',
  expirationTime: null,
  vapidPublicKeyFingerprint: fingerprintVapidPublicKey(publicKey),
  subscriptionFingerprint: 'c'.repeat(64),
  createdAt: new Date('2026-07-22T08:00:00.000Z'),
  updatedAt: new Date('2026-07-22T08:00:00.000Z'),
  disabledAt: null,
  disabledReason: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  consecutiveFailures: 0,
} as const;

describe('WebPushService status', () => {
  it('returns disabled status without reading subscription storage', async () => {
    const repository = { findCurrentSession: vi.fn() };
    const service = new WebPushService(disabledConfig, repository as never);

    await expect(service.status(identity)).resolves.toEqual({
      enabled: false,
      vapidPublicKey: null,
      renewalRequired: false,
      subscription: null,
    });
    expect(repository.findCurrentSession).not.toHaveBeenCalled();
  });

  it('returns only public capability and safe current-session metadata', async () => {
    const repository = {
      findCurrentSession: vi.fn().mockResolvedValue(activeSubscription),
    };
    const service = new WebPushService(enabledConfig, repository as never);

    const status = await service.status(identity);

    expect(status).toEqual({
      enabled: true,
      vapidPublicKey: publicKey,
      renewalRequired: false,
      subscription: {
        id: activeSubscription.id,
        createdAt: '2026-07-22T08:00:00.000Z',
        fingerprint: activeSubscription.subscriptionFingerprint,
      },
    });
    expect(JSON.stringify(status)).not.toContain(activeSubscription.endpoint);
    expect(JSON.stringify(status)).not.toContain(activeSubscription.p256dh);
    expect(JSON.stringify(status)).not.toContain(activeSubscription.auth);
    expect(JSON.stringify(status)).not.toContain(enabledConfig.vapidPrivateKey);
  });

  it('requires renewal for an active subscription signed to another VAPID key', async () => {
    const repository = {
      findCurrentSession: vi.fn().mockResolvedValue({
        ...activeSubscription,
        vapidPublicKeyFingerprint: 'd'.repeat(64),
      }),
    };
    const service = new WebPushService(enabledConfig, repository as never);

    await expect(service.status(identity)).resolves.toMatchObject({
      renewalRequired: true,
      subscription: { id: activeSubscription.id },
    });
  });

  it.each(['PROVIDER_STALE', 'VAPID_ROTATED'] as const)(
    'requires explicit renewal for disabled reason %s',
    async (disabledReason) => {
      const repository = {
        findCurrentSession: vi.fn().mockResolvedValue({
          ...activeSubscription,
          disabledAt: new Date('2026-07-22T09:00:00.000Z'),
          disabledReason,
        }),
      };
      const service = new WebPushService(enabledConfig, repository as never);

      await expect(service.status(identity)).resolves.toEqual({
        enabled: true,
        vapidPublicKey: publicKey,
        renewalRequired: true,
        subscription: null,
      });
    },
  );
});

describe('WebPushService create', () => {
  const input = {
    endpoint: activeSubscription.endpoint,
    expirationTime: null,
    keys: {
      p256dh: activeSubscription.p256dh,
      auth: activeSubscription.auth,
    },
  };

  it('rejects disabled create without touching storage', async () => {
    const repository = { upsert: vi.fn() };
    const service = new WebPushService(disabledConfig, repository as never);

    await expect(service.create(identity, input)).rejects.toMatchObject({
      code: 'WEB_PUSH_DISABLED',
      statusCode: 409,
    });
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it('creates through current-session identity and returns only safe metadata', async () => {
    const repository = { upsert: vi.fn().mockResolvedValue(activeSubscription) };
    const service = new WebPushService(enabledConfig, repository as never);

    const created = await service.create(identity, input);

    expect(repository.upsert).toHaveBeenCalledWith(expect.objectContaining({
      ...identity,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      expirationTime: null,
      vapidPublicKeyFingerprint: fingerprintVapidPublicKey(publicKey),
    }));
    expect(created).toEqual({
      id: activeSubscription.id,
      createdAt: activeSubscription.createdAt.toISOString(),
      fingerprint: activeSubscription.subscriptionFingerprint,
    });
    expect(JSON.stringify(created)).not.toContain(input.endpoint);
    expect(JSON.stringify(created)).not.toContain(input.keys.p256dh);
    expect(JSON.stringify(created)).not.toContain(input.keys.auth);
  });

  it('maps endpoint ownership conflicts without revealing the existing owner', async () => {
    const repository = {
      upsert: vi.fn().mockRejectedValue(new WebPushOwnershipConflictError()),
    };
    const service = new WebPushService(enabledConfig, repository as never);

    await expect(service.create(identity, input)).rejects.toMatchObject({
      code: 'PUSH_SUBSCRIPTION_CONFLICT',
      statusCode: 409,
      details: null,
    });
  });
});
