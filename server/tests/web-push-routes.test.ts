import { createECDH } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';
import { fingerprintVapidPublicKey } from '../src/modules/web-push/repository.js';

const vapidPrivateKey = Buffer.alloc(32, 0);
vapidPrivateKey[31] = 1;
const vapidEcdh = createECDH('prime256v1');
vapidEcdh.setPrivateKey(vapidPrivateKey);
const vapidPublicKey = vapidEcdh.getPublicKey().toString('base64url');
const enabledWebPush = {
  enabled: true,
  vapidSubject: 'mailto:operations@example.com',
  vapidPublicKey,
  vapidPrivateKey: vapidPrivateKey.toString('base64url'),
} as const;

const config = {
  nodeEnv: 'test' as const,
  host: '127.0.0.1',
  port: 3000,
  databaseUrl: 'postgresql://unused',
  logLevel: 'silent',
  corsOrigin: 'https://app.example.com',
  sessionTtlSeconds: 28_800,
  loginRateLimitMax: 100,
  rateLimitWindowMs: 60_000,
  trustedProxy: 'loopback' as const,
  healthSchemaVersion: null,
  actionScopedGeolocationEnabled: false,
  reverseGeocoderProvider: null,
  googleGeocodingApiKey: null,
  reverseGeocoderTimeoutMs: 2000,
  geocodingUserDailyLimit: 15,
  geocodingOrganizationDailyLimit: 250,
  geocodingGlobalMonthlyLimit: 8000,
  webPush: {
    enabled: false,
    vapidSubject: null,
    vapidPublicKey: null,
    vapidPrivateKey: null,
  },
};

class MemoryAuthRepository implements AuthRepository {
  sessions: SessionRecord[] = [];

  constructor(readonly user: AuthUserRecord) {}

  async findUserByEmail(email: string) { return this.user.email === email ? this.user : null; }
  async findUserById(id: string) { return this.user.id === id ? this.user : null; }
  async createSession(input: Omit<SessionRecord, 'id' | 'revokedAt'>) {
    const session = { ...input, id: 'session-1', revokedAt: null };
    this.sessions.push(session);
    return session;
  }
  async findSessionWithUser(hash: string) {
    const session = this.sessions.find((item) => item.tokenHash === hash);
    return session ? { session, user: this.user } : null;
  }
  async revokeSession(hash: string, at: Date) {
    const session = this.sessions.find((item) => item.tokenHash === hash);
    if (session) session.revokedAt ??= at;
  }
  async updatePasswordAndRevokeSessions() { return false; }
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function createApp(
  mustChangePassword = false,
  webPush: typeof config.webPush | typeof enabledWebPush = config.webPush,
) {
  const authRepository = new MemoryAuthRepository({
    id: 'user-1',
    organizationId: 'organization-1',
    name: 'Staff',
    email: 'staff@example.com',
    passwordHash: await hashPassword('correct-password'),
    role: 'STAFF',
    mustChangePassword,
    isActive: true,
    version: 1,
  });
  const webPushRepository = {
    findCurrentSession: vi.fn(),
    upsert: vi.fn().mockImplementation(async (input) => ({
      id: 'subscription-1',
      organizationId: input.organizationId,
      recipientUserId: input.userId,
      sessionId: input.sessionId,
      endpoint: input.endpoint,
      endpointHash: 'a'.repeat(64),
      p256dh: input.p256dh,
      auth: input.auth,
      expirationTime: input.expirationTime,
      vapidPublicKeyFingerprint: fingerprintVapidPublicKey(vapidPublicKey),
      subscriptionFingerprint: 'c'.repeat(64),
      createdAt: new Date('2026-07-22T08:00:00.000Z'),
      updatedAt: input.now,
      disabledAt: null,
      disabledReason: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
    })),
    disable: vi.fn(),
  };
  const app = await buildApp({ ...config, webPush }, { authRepository, webPushRepository });
  apps.push(app);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: authRepository.user.email, password: 'correct-password' },
  });
  return {
    app,
    cookie: login.headers['set-cookie'] as string,
    webPushRepository,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Web Push HTTP routes', () => {
  it('requires authentication and a completed forced-password change', async () => {
    const { app } = await createApp();
    expect((await app.inject({
      method: 'GET', url: '/api/web-push/status',
    })).statusCode).toBe(401);

    const forced = await createApp(true);
    const response = await forced.app.inject({
      method: 'GET',
      url: '/api/web-push/status',
      headers: { cookie: forced.cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
  });

  it('returns default-off capability without reading storage', async () => {
    const { app, cookie, webPushRepository } = await createApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/web-push/status',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      enabled: false,
      vapidPublicKey: null,
      renewalRequired: false,
      subscription: null,
    });
    expect(webPushRepository.findCurrentSession).not.toHaveBeenCalled();
  });

  it('rejects create while disabled without writing subscription storage', async () => {
    const { app, cookie, webPushRepository } = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/web-push/subscriptions',
      headers: { cookie },
      payload: {
        endpoint: 'https://fcm.googleapis.com/push/example',
        expirationTime: null,
        keys: {
          p256dh: Buffer.alloc(65, 4).toString('base64url'),
          auth: Buffer.alloc(16, 7).toString('base64url'),
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'WEB_PUSH_DISABLED' });
    expect(webPushRepository.upsert).not.toHaveBeenCalled();
  });

  it('creates for the authenticated current session and returns safe metadata', async () => {
    const { app, cookie, webPushRepository } = await createApp(false, enabledWebPush);
    const endpoint = 'https://fcm.googleapis.com/push/example';
    const p256dh = Buffer.alloc(65, 4).toString('base64url');
    const auth = Buffer.alloc(16, 7).toString('base64url');

    const response = await app.inject({
      method: 'POST',
      url: '/api/web-push/subscriptions',
      headers: { cookie },
      payload: { endpoint, expirationTime: null, keys: { p256dh, auth } },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: 'subscription-1',
      createdAt: '2026-07-22T08:00:00.000Z',
      fingerprint: 'c'.repeat(64),
    });
    expect(webPushRepository.upsert).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'organization-1',
      userId: 'user-1',
      sessionId: 'session-1',
    }));
    expect(response.body).not.toContain(endpoint);
    expect(response.body).not.toContain(p256dh);
    expect(response.body).not.toContain(auth);
  });

  it('disables idempotently in current-session scope and hides other scopes', async () => {
    const { app, cookie, webPushRepository } = await createApp();
    const subscriptionId = '11111111-1111-4111-8111-111111111111';
    webPushRepository.disable.mockResolvedValue({ id: subscriptionId });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/web-push/subscriptions/${subscriptionId}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(204);
    }

    webPushRepository.disable.mockResolvedValueOnce(null);
    expect((await app.inject({
      method: 'DELETE',
      url: `/api/web-push/subscriptions/${subscriptionId}`,
      headers: { cookie },
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: 'DELETE',
      url: '/api/web-push/subscriptions/not-a-uuid',
      headers: { cookie },
    })).statusCode).toBe(400);
  });

  it('rate-limits mutations per session without charging status reads', async () => {
    const { app, cookie } = await createApp();
    const payload = {
      endpoint: 'https://fcm.googleapis.com/push/example',
      expirationTime: null,
      keys: {
        p256dh: Buffer.alloc(65, 4).toString('base64url'),
        auth: Buffer.alloc(16, 7).toString('base64url'),
      },
    };

    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await app.inject({
        method: 'POST',
        url: '/api/web-push/subscriptions',
        headers: { cookie },
        payload,
      })).statusCode).toBe(409);
      expect((await app.inject({
        method: 'GET',
        url: '/api/web-push/status',
        headers: { cookie },
      })).statusCode).toBe(200);
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/api/web-push/subscriptions',
      headers: { cookie },
      payload,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  });
});
