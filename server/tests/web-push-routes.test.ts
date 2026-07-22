import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';

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

async function createApp(mustChangePassword = false) {
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
  const webPushRepository = { findCurrentSession: vi.fn() };
  const app = await buildApp(config, { authRepository, webPushRepository });
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
});
