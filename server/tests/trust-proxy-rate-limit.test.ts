import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { resolveTrustProxyOption, type AppConfig } from '../src/config.js';
import { hashPassword } from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';

class MemoryRepository implements AuthRepository {
  user!: AuthUserRecord;
  sessions: SessionRecord[] = [];

  async findUserByEmail(email: string) { return this.user.email === email ? this.user : null; }
  async findUserById(id: string) { return this.user.id === id ? this.user : null; }
  async createSession(input: Omit<SessionRecord, 'id' | 'revokedAt'>) {
    const session = { ...input, id: `session-${this.sessions.length + 1}`, revokedAt: null };
    this.sessions.push(session); return session;
  }
  async findSessionWithUser(hash: string) {
    const session = this.sessions.find((item) => item.tokenHash === hash);
    return session ? { session, user: this.user } : null;
  }
  async revokeSession(hash: string, at: Date) {
    const session = this.sessions.find((item) => item.tokenHash === hash);
    if (session && !session.revokedAt) session.revokedAt = at;
  }
  async updatePasswordAndRevokeSessions() { return false; }
}

const baseConfig: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  databaseUrl: 'postgresql://unused',
  logLevel: 'silent',
  corsOrigin: 'https://app.example.com',
  sessionTtlSeconds: 28_800,
  loginRateLimitMax: 2,
  rateLimitWindowMs: 60_000,
  trustedProxy: 'loopback',
  healthSchemaVersion: null,
};

describe('resolveTrustProxyOption', () => {
  it('maps loopback mode without enabling trust for all peers', () => {
    expect(resolveTrustProxyOption('loopback')).toBe('loopback');
    expect(resolveTrustProxyOption('127.0.0.1')).toBe('127.0.0.1');
    expect(resolveTrustProxyOption('::1')).toBe('::1');
  });
});

describe('trusted proxy login rate limits', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function readyApp() {
    const repository = new MemoryRepository();
    repository.user = {
      id: 'user-1',
      organizationId: 'org-1',
      name: 'Admin',
      email: 'admin@example.com',
      passwordHash: await hashPassword('password-123456'),
      role: 'ADMIN',
      mustChangePassword: false,
      isActive: true,
      version: 1,
    };
    const app = await buildApp(baseConfig, { authRepository: repository });
    apps.push(app);
    return app;
  }

  it('uses distinct forwarded client IPs when the peer is loopback', async () => {
    const app = await readyApp();
    const payload = { email: 'admin@example.com', password: 'wrong-password' };

    const firstClient = async () => app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.1',
      headers: {
        origin: baseConfig.corsOrigin,
        'x-forwarded-for': '203.0.113.10',
      },
      payload,
    });
    const secondClient = async () => app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.1',
      headers: {
        origin: baseConfig.corsOrigin,
        'x-forwarded-for': '203.0.113.20',
      },
      payload,
    });

    expect((await firstClient()).statusCode).toBe(401);
    expect((await firstClient()).statusCode).toBe(401);
    expect((await firstClient()).statusCode).toBe(429);

    // Independent bucket for a different forwarded client.
    expect((await secondClient()).statusCode).toBe(401);
    expect((await secondClient()).statusCode).toBe(401);
    expect((await secondClient()).statusCode).toBe(429);
  });

  it('does not trust X-Forwarded-For from a non-loopback peer', async () => {
    const app = await readyApp();
    const payload = { email: 'admin@example.com', password: 'wrong-password' };

    const spoofed = async (forwarded: string) => app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.50',
      headers: {
        origin: baseConfig.corsOrigin,
        'x-forwarded-for': forwarded,
      },
      payload,
    });

    // Same peer IP even when XFF changes — one shared bucket.
    expect((await spoofed('203.0.113.1')).statusCode).toBe(401);
    expect((await spoofed('203.0.113.2')).statusCode).toBe(401);
    expect((await spoofed('203.0.113.3')).statusCode).toBe(429);
  });
});
