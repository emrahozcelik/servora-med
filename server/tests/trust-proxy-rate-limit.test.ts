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
  async createSessionIfCredentialCurrent(
    input: Omit<SessionRecord, 'id' | 'revokedAt'> & { expectedPasswordHash: string },
  ) {
    if (input.userId !== this.user.id || !this.user.isActive
      || input.expectedPasswordHash !== this.user.passwordHash) return null;
    const session: SessionRecord = {
      id: `session-${this.sessions.length + 1}`, userId: input.userId,
      tokenHash: input.tokenHash, expiresAt: input.expiresAt, revokedAt: null,
    };
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
  releaseSha: 'dev',
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

  // Regression coverage for GHSA-grpc-p53c-r64v (CVE-2026-15144), fixed in
  // @fastify/rate-limit 11.2.0. Before that release the bucket key was the
  // verbatim `request.ip` string, so an IPv6 client could reset its budget by
  // rotating the interface identifier inside its own /64, or by rewriting the
  // same address in a different textual form.
  describe('IPv6 client identity normalization', () => {
    const payload = { email: 'admin@example.com', password: 'wrong-password' };

    const attempt = (app: Awaited<ReturnType<typeof buildApp>>, forwarded: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '127.0.0.1',
        headers: {
          origin: baseConfig.corsOrigin,
          'x-forwarded-for': forwarded,
        },
        payload,
      });

    it('collapses address rotation within one /64 into a single bucket', async () => {
      const app = await readyApp();

      // Three distinct interface identifiers inside 2001:db8:1:2::/64.
      expect((await attempt(app, '2001:db8:1:2::1')).statusCode).toBe(401);
      expect((await attempt(app, '2001:db8:1:2::beef')).statusCode).toBe(401);
      // Rotating the address must NOT buy a fresh bucket.
      expect((await attempt(app, '2001:db8:1:2:aaaa:bbbb:cccc:dddd')).statusCode).toBe(429);
    });

    it('keeps distinct IPv6 /64 prefixes in independent buckets', async () => {
      const app = await readyApp();

      expect((await attempt(app, '2001:db8:1:2::1')).statusCode).toBe(401);
      expect((await attempt(app, '2001:db8:1:2::2')).statusCode).toBe(401);
      expect((await attempt(app, '2001:db8:1:2::3')).statusCode).toBe(429);

      // A different /64 is a different client identity.
      expect((await attempt(app, '2001:db8:1:3::1')).statusCode).toBe(401);
    });

    it('normalizes equivalent IPv6 textual forms to one identity', async () => {
      const app = await readyApp();

      // Expanded, zero-padded, upper-case form of 2001:db8:1:2::1.
      expect((await attempt(app, '2001:DB8:0001:0002:0000:0000:0000:0001')).statusCode).toBe(401);
      // Compressed lower-case form of the same address.
      expect((await attempt(app, '2001:db8:1:2::1')).statusCode).toBe(401);
      expect((await attempt(app, '2001:db8:1:2::2')).statusCode).toBe(429);
    });

    it('collapses IPv4-mapped IPv6 to the plain IPv4 identity', async () => {
      const app = await readyApp();

      expect((await attempt(app, '203.0.113.10')).statusCode).toBe(401);
      // Same host, IPv4-mapped textual form — must share the IPv4 bucket.
      expect((await attempt(app, '::ffff:203.0.113.10')).statusCode).toBe(401);
      expect((await attempt(app, '::ffff:203.0.113.10')).statusCode).toBe(429);
    });
  });
});
