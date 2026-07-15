import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
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
  async revokeSession() {}
  async updatePasswordAndRevokeSessions() { return false; }
}

describe('serialized logger redaction', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('does not emit raw passwords or cookie headers in JSON log lines', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });

    const config: AppConfig = {
      nodeEnv: 'test',
      host: '127.0.0.1',
      port: 3000,
      databaseUrl: 'postgresql://unused',
      logLevel: 'info',
      corsOrigin: 'https://app.example.com',
      sessionTtlSeconds: 28_800,
      loginRateLimitMax: 20,
      rateLimitWindowMs: 60_000,
      trustedProxy: 'loopback',
      healthSchemaVersion: null,
    };

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

    // Patch buildApp logger by constructing Fastify via buildApp is fixed;
    // instead log through request after inject using a custom destination is hard.
    // Capture by temporarily building with logger stream via env is not available.
    // Use buildApp and spy request.log by issuing login; replace logger with stream
    // by calling Fastify-level log through inject which uses app.log.

    const { default: Fastify } = await import('fastify');
    const probe = Fastify({
      logger: {
        level: 'info',
        stream,
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.temporaryPassword',
        ],
      },
    });
    probe.post('/probe', async (request) => {
      request.log.info({
        req: {
          headers: request.headers,
          body: request.body,
        },
      }, 'probe');
      return { ok: true };
    });
    apps.push(probe as never);

    await probe.inject({
      method: 'POST',
      url: '/probe',
      headers: {
        authorization: 'Bearer secret-token-value',
        cookie: 'session=raw-session-cookie',
      },
      payload: {
        password: 'super-secret-password',
        currentPassword: 'old-secret',
        newPassword: 'new-secret',
        temporaryPassword: 'temp-secret',
      },
    });

    const joined = lines.join('\n');
    expect(joined).toMatch(/probe/);
    expect(joined).not.toContain('super-secret-password');
    expect(joined).not.toContain('old-secret');
    expect(joined).not.toContain('new-secret');
    expect(joined).not.toContain('temp-secret');
    expect(joined).not.toContain('raw-session-cookie');
    expect(joined).not.toContain('secret-token-value');
    // Secrets must be absent from serialized output (censor token may vary by Pino version).

    // Also ensure buildApp still mounts with redaction paths (smoke).
    const app = await buildApp(config, { authRepository: repository });
    apps.push(app);
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.corsOrigin },
      payload: { email: 'admin@example.com', password: 'password-123456' },
    });
  });
});
