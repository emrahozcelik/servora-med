import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Proves the login invalid-credential branches all execute the same password
 * verification path, so "no such email" cannot be distinguished from "known
 * email, wrong password" by skipping key-derivation work.
 *
 * The observation seam is a counted wrapper around `verifyPassword`, the only
 * KDF entry point on the login path. Assertions are structural (call count and
 * the hash actually verified against) rather than wall-clock, so they are not
 * timing-brittle on loaded CI machines.
 */
const spies = vi.hoisted(() => ({
  verifyPasswordCalls: 0,
  storedHashes: [] as string[],
  sentinelDerivations: 0,
  sentinelMemo: null as Promise<string> | null,
}));

vi.mock('../src/modules/auth/crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/auth/crypto.js')>();
  return {
    ...actual,
    // Counted seam around the one-time sentinel derivation. `invalidCredentialSentinelHash`
    // calls the module-local `hashPassword`, so mocking `hashPassword` would NOT observe the
    // derivation; wrapping the sentinel entry point itself is the seam that actually sees it.
    // The wrapper mirrors the production memoization contract exactly (single-flight `??=`),
    // so the counter increments precisely when a real derivation would occur.
    invalidCredentialSentinelHash() {
      spies.sentinelMemo ??= (async () => {
        spies.sentinelDerivations += 1;
        return actual.invalidCredentialSentinelHash();
      })();
      return spies.sentinelMemo;
    },
    async verifyPassword(password: string, storedHash: string) {
      spies.verifyPasswordCalls += 1;
      spies.storedHashes.push(storedHash);
      return actual.verifyPassword(password, storedHash);
    },
  };
});

import { buildApp } from '../src/app.js';
import {
  hashPassword,
  invalidCredentialSentinelHash,
  parsePasswordHash,
} from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import { AuthService } from '../src/modules/auth/service.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';

class MemoryAuthRepository implements AuthRepository {
  users: AuthUserRecord[] = [];
  sessions: SessionRecord[] = [];

  async findUserByEmail(email: string) {
    return this.users.find((user) => user.email.toLowerCase() === email) ?? null;
  }

  async findUserById(id: string) {
    return this.users.find((user) => user.id === id) ?? null;
  }

  async createSessionIfCredentialCurrent(
    input: Omit<SessionRecord, 'id' | 'revokedAt'> & { expectedPasswordHash: string },
  ) {
    const user = this.users.find((candidate) => candidate.id === input.userId);
    if (!user || !user.isActive || user.passwordHash !== input.expectedPasswordHash) return null;
    const session: SessionRecord = {
      id: `session-${this.sessions.length + 1}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    this.sessions.push(session);
    return session;
  }

  async findSessionWithUser(tokenHash: string) {
    const session = this.sessions.find((candidate) => candidate.tokenHash === tokenHash);
    const user = session && this.users.find((candidate) => candidate.id === session.userId);
    return session && user ? { session, user } : null;
  }

  async revokeSession(tokenHash: string, revokedAt: Date) {
    const session = this.sessions.find((candidate) => candidate.tokenHash === tokenHash);
    if (session && !session.revokedAt) session.revokedAt = revokedAt;
  }

  async updatePasswordAndRevokeSessions(
    userId: string,
    expectedPasswordHash: string,
    passwordHash: string,
    revokedAt: Date,
  ) {
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user || user.passwordHash !== expectedPasswordHash) return false;
    user.passwordHash = passwordHash;
    user.mustChangePassword = false;
    user.version += 1;
    for (const session of this.sessions) {
      if (session.userId === userId && !session.revokedAt) session.revokedAt = revokedAt;
    }
    return true;
  }
}

describe('login invalid-credential constant work', () => {
  const now = new Date('2026-10-01T08:00:00.000Z');
  let repository: MemoryAuthRepository;
  let service: AuthService;

  beforeEach(async () => {
    spies.verifyPasswordCalls = 0;
    spies.storedHashes.length = 0;
    repository = new MemoryAuthRepository();
    repository.users.push({
      id: 'user-1', organizationId: 'org-1', name: 'Admin User',
      email: 'admin@example.com', passwordHash: await hashPassword('correct-password'),
      role: 'ADMIN', mustChangePassword: false, isActive: true, version: 1,
    });
    service = new AuthService(repository, 28_800, () => now);
  });

  it('verifies exactly once against the sentinel for an unknown email', async () => {
    await expect(service.login('nobody@example.com', 'wrong-password'))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expect(spies.verifyPasswordCalls).toBe(1);
    // The sentinel — never a fabricated account row and never the real hash.
    expect(spies.storedHashes[0]).toBe(await invalidCredentialSentinelHash());
    expect(spies.storedHashes[0]).not.toBe(repository.users[0]!.passwordHash);
    expect(repository.sessions).toHaveLength(0);
  });

  it('verifies exactly once for an inactive account before the generic reject', async () => {
    repository.users[0]!.isActive = false;

    await expect(service.login('admin@example.com', 'correct-password'))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expect(spies.verifyPasswordCalls).toBe(1);
    expect(spies.storedHashes[0]).toBe(repository.users[0]!.passwordHash);
    expect(repository.sessions).toHaveLength(0);
  });

  it('verifies exactly once for a wrong password', async () => {
    await expect(service.login('admin@example.com', 'wrong-password'))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expect(spies.verifyPasswordCalls).toBe(1);
    expect(spies.storedHashes[0]).toBe(repository.users[0]!.passwordHash);
    expect(repository.sessions).toHaveLength(0);
  });

  it('verifies exactly once on a successful login', async () => {
    const result = await service.login('admin@example.com', 'correct-password');

    expect(spies.verifyPasswordCalls).toBe(1);
    expect(spies.storedHashes[0]).toBe(repository.users[0]!.passwordHash);
    expect(result.rawToken).toHaveLength(43);
    expect(repository.sessions).toHaveLength(1);
  });
});

describe('invalid-credential sentinel', () => {
  it('is a genuine scrypt artifact of the production parameter set', async () => {
    // Parse through the production SSOT (no second parser): the sentinel must
    // be a CURRENT v1 artifact with the production 16-byte salt / 64-byte key.
    const artifact = parsePasswordHash(await invalidCredentialSentinelHash());

    expect(artifact?.profile).toBe('SCRYPT_V1');
    expect(artifact?.salt).toHaveLength(16);
    expect(artifact?.key).toHaveLength(64);
  });

  it('is derived once per process, never per request', async () => {
    const [concurrent, memoized] = await Promise.all([
      invalidCredentialSentinelHash(),
      invalidCredentialSentinelHash(),
    ]);

    expect(concurrent).toBe(memoized);
    expect(await invalidCredentialSentinelHash()).toBe(concurrent);
  });
});

/**
 * Cold-start regression.
 *
 * The sentinel is memoized, so if it is first derived lazily by the first
 * unknown-account login, that single request pays two scrypt derivations
 * (create the sentinel, then verify the supplied password) while a known
 * account with a wrong password pays one. That re-creates an account-existence
 * timing distinction for the first unknown login after every process start.
 *
 * The fix derives the sentinel during `buildApp`. These tests use the counted
 * derivation seam above (not wall-clock) to prove the derivation has already
 * happened by the time `buildApp` resolves, and that no later login re-derives.
 */
const appConfig = {
  nodeEnv: 'test' as const, host: '127.0.0.1', port: 3000,
  databaseUrl: 'postgresql://unused', logLevel: 'silent',
  corsOrigin: 'https://app.example.com', sessionTtlSeconds: 28_800,
  loginRateLimitMax: 50, rateLimitWindowMs: 60_000,
  trustedProxy: 'loopback' as const, healthSchemaVersion: null, releaseSha: 'dev',
  capabilities: {
    overviewDashboard: true,
    calendar: false,
    messaging: false,
    backup: false,
    demoDatasetCreation: false,
  },
  support: {
    displayLabel: 'Operasyon desteği',
    email: 'destek@example.test',
    helpUrl: 'https://help.example.test',
  },
};

describe('invalid-credential sentinel warmup at app construction', () => {
  let repository: MemoryAuthRepository;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    spies.verifyPasswordCalls = 0;
    spies.storedHashes.length = 0;
    spies.sentinelDerivations = 0;
    spies.sentinelMemo = null;
    repository = new MemoryAuthRepository();
    repository.users.push({
      id: 'user-1', organizationId: 'org-1', name: 'Admin User',
      email: 'admin@example.com', passwordHash: await hashPassword('correct-password'),
      role: 'ADMIN', mustChangePassword: false, isActive: true, version: 1,
    });
    app = await buildApp(appConfig, { authRepository: repository });
  });

  afterEach(async () => {
    await app.close();
  });

  it('derives the sentinel during buildApp, before any request can be served', () => {
    // `buildApp` has resolved and no HTTP request exists yet. The production
    // server only reaches `listen()` after this resolves, so the derivation is
    // already complete before the first login can arrive.
    expect(spies.sentinelDerivations).toBe(1);
  });

  it('does not re-derive on the first unknown-email login and verifies exactly once', async () => {
    // Baseline captured after construction: the cold-start login must not add a
    // derivation on top of it (that would be the lazy two-KDF path this fix removes).
    const warmedDerivations = spies.sentinelDerivations;

    const response = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { origin: appConfig.corsOrigin },
      payload: { email: 'nobody@example.com', password: 'wrong-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    // The cold-start request must reuse the warmed sentinel, not derive a new one.
    expect(spies.sentinelDerivations).toBe(warmedDerivations);
    expect(spies.verifyPasswordCalls).toBe(1);
    expect(spies.storedHashes[0]).toBe(await invalidCredentialSentinelHash());
    expect(repository.sessions).toHaveLength(0);
  });

  it('performs exactly one verification for a known user with a wrong password', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { origin: appConfig.corsOrigin },
      payload: { email: 'admin@example.com', password: 'wrong-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(spies.sentinelDerivations).toBe(1);
    expect(spies.verifyPasswordCalls).toBe(1);
    expect(spies.storedHashes[0]).toBe(repository.users[0]!.passwordHash);
    expect(repository.sessions).toHaveLength(0);
  });

  it('leaves successful login unchanged', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { origin: appConfig.corsOrigin },
      payload: { email: 'admin@example.com', password: 'correct-password' },
    });

    expect(response.statusCode).toBe(200);
    expect(spies.verifyPasswordCalls).toBe(1);
    expect(repository.sessions).toHaveLength(1);
    expect(response.headers['set-cookie']).toMatch(/servora_session=/);
  });
});
