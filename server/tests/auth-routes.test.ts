import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';

class MemoryRepository implements AuthRepository {
  user!: AuthUserRecord;
  sessions: SessionRecord[] = [];

  async findUserByEmail(email: string) { return this.user.email === email ? this.user : null; }
  async findUserById(id: string) { return this.user.id === id ? this.user : null; }
  async createSession(input: Omit<SessionRecord, 'id' | 'revokedAt'>) {
    const session = { ...input, id: 'session-1', revokedAt: null };
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
  async updatePasswordAndRevokeSessions(id: string, expected: string, passwordHash: string, at: Date) {
    if (id !== this.user.id || expected !== this.user.passwordHash) return false;
    this.user.passwordHash = passwordHash;
    this.user.mustChangePassword = false;
    this.sessions.forEach((session) => { session.revokedAt ??= at; });
    return true;
  }
}

const baseConfig = {
  nodeEnv: 'test' as const, host: '127.0.0.1', port: 3000,
  databaseUrl: 'postgresql://unused', logLevel: 'silent',
  corsOrigin: 'https://app.example.com', sessionTtlSeconds: 28_800,
  loginRateLimitMax: 2, rateLimitWindowMs: 60_000,
};

describe('auth HTTP routes', () => {
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    repository = new MemoryRepository();
    repository.user = {
      id: 'user-1', organizationId: 'org-1', name: 'Admin', email: 'admin@example.com',
      passwordHash: await hashPassword('correct-password'), role: 'ADMIN',
      mustChangePassword: false, isActive: true,
    };
    app = await buildApp(baseConfig, { authRepository: repository });
  });
  afterEach(() => app.close());

  it('logs in with a secure HttpOnly cookie and a safe user body', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { origin: baseConfig.corsOrigin },
      payload: { email: 'admin@example.com', password: 'correct-password' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: expect.objectContaining({ email: 'admin@example.com', role: 'ADMIN' }) });
    expect(response.body).not.toContain('passwordHash');
    expect(response.headers['set-cookie']).toMatch(/servora_session=.*HttpOnly.*SameSite=Lax/i);
  });

  it('returns a generic unauthorized response for invalid credentials', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login',
      headers: { origin: baseConfig.corsOrigin },
      payload: { email: 'admin@example.com', password: 'wrong-password' } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('requires a valid cookie for me and clears it on logout', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(missing.statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      headers: { origin: baseConfig.corsOrigin },
      payload: { email: 'admin@example.com', password: 'correct-password' } });
    const cookie = login.headers['set-cookie'] as string;
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout',
      headers: { cookie, origin: baseConfig.corsOrigin } });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers['set-cookie']).toMatch(/Max-Age=0/i);
  });

  it('changes password and clears the current session', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      headers: { origin: baseConfig.corsOrigin },
      payload: { email: 'admin@example.com', password: 'correct-password' } });
    const response = await app.inject({ method: 'POST', url: '/api/auth/change-password',
      headers: { cookie: login.headers['set-cookie'] as string, origin: baseConfig.corsOrigin },
      payload: { currentPassword: 'correct-password', newPassword: 'new-secure-password' } });
    expect(response.statusCode).toBe(204);
    expect(response.headers['set-cookie']).toMatch(/Max-Age=0/i);
  });

  it('rejects missing or mismatched origins for unsafe production requests', async () => {
    const production = await buildApp({ ...baseConfig, nodeEnv: 'production' }, { authRepository: repository });
    const payload = { email: 'admin@example.com', password: 'correct-password' };
    const missing = await production.inject({ method: 'POST', url: '/api/auth/login', payload });
    const wrong = await production.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example' }, payload });
    expect(missing.statusCode).toBe(403);
    expect(wrong.statusCode).toBe(403);
    const accepted = await production.inject({ method: 'POST', url: '/api/auth/login',
      headers: { origin: baseConfig.corsOrigin }, payload });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers['set-cookie']).toMatch(/Secure/i);
    await production.close();
  });

  it('allows the configured CORS origin with credentials', async () => {
    const response = await app.inject({ method: 'OPTIONS', url: '/api/auth/login',
      headers: { origin: baseConfig.corsOrigin, 'access-control-request-method': 'POST' } });
    expect(response.headers['access-control-allow-origin']).toBe(baseConfig.corsOrigin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rate limits repeated login attempts', async () => {
    const request = () => app.inject({ method: 'POST', url: '/api/auth/login',
      headers: { origin: baseConfig.corsOrigin },
      payload: { email: 'admin@example.com', password: 'wrong-password' } });
    await request(); await request();
    expect((await request()).statusCode).toBe(429);
  });
});
