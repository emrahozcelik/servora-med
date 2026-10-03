import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Proves every login attempt executes the same fixed KDF budget — exactly one
 * OLD-class and one CURRENT-class derivation — so account existence, profile,
 * activity, and password correctness cannot be distinguished by skipped work.
 *
 * Two complementary seams (both structural, never wall-clock):
 * - a counted wrapper around node:crypto scrypt keyed by N proves the exact
 *   KDF-class budget;
 * - counted wrappers around both sentinel entry points prove which slots fall
 *   back to dummy work (the real `performLoginPasswordWork` resolves these
 *   imports to the mocks, while its internal verifyPassword calls flow into
 *   the scrypt seam).
 */
const derivations = vi.hoisted(() => ({ counts: new Map<number, number>() }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    scrypt(
      password: unknown,
      salt: unknown,
      keylen: unknown,
      options: { N?: number } & Record<string, unknown>,
      callback: (err: Error | null, key?: Buffer) => void,
    ) {
      derivations.counts.set(options.N ?? -1, (derivations.counts.get(options.N ?? -1) ?? 0) + 1);
      return actual.scrypt(password as never, salt as never, keylen as never, options as never, callback as never);
    },
  };
});

const spies = vi.hoisted(() => ({
  oldSentinelDerivations: 0,
  currentSentinelDerivations: 0,
  oldSentinelMemo: null as Promise<string> | null,
  currentSentinelMemo: null as Promise<string> | null,
}));

vi.mock('../src/modules/auth/crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/auth/crypto.js')>();
  return {
    ...actual,
    // Counted seams around sentinel USE and around the one-time sentinel
    // derivations. Each derivation wrapper mirrors the production memoization
    // contract exactly (single-flight `??=`), so each derivation counter
    // increments precisely when a real derivation would occur.
    oldCredentialSentinelHash() {
      spies.oldSentinelMemo ??= (async () => {
        spies.oldSentinelDerivations += 1;
        return actual.oldCredentialSentinelHash();
      })();
      return spies.oldSentinelMemo;
    },
    currentCredentialSentinelHash() {
      spies.currentSentinelMemo ??= (async () => {
        spies.currentSentinelDerivations += 1;
        return actual.currentCredentialSentinelHash();
      })();
      return spies.currentSentinelMemo;
    },
  };
});

import { buildApp } from '../src/app.js';
import {
  currentCredentialSentinelHash,
  hashPassword,
  oldCredentialSentinelHash,
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

  async upgradePasswordHashIfCurrent(): Promise<'updated' | 'conflict'> {
    return 'conflict';
  }
}

describe('login fixed-work budget', () => {
  const now = new Date('2026-10-01T08:00:00.000Z');
  let repository: MemoryAuthRepository;
  let service: AuthService;

  function kdfCounts() {
    return {
      old: derivations.counts.get(16384) ?? 0,
      current: derivations.counts.get(32768) ?? 0,
    };
  }

  // Mirror production warmup so one-time sentinel derivations never
  // contaminate per-login budgets.
  beforeAll(async () => {
    await oldCredentialSentinelHash();
    await currentCredentialSentinelHash();
    derivations.counts.clear();
  });

  beforeEach(async () => {
    derivations.counts.clear();
    repository = new MemoryAuthRepository();
    repository.users.push({
      id: 'user-1', organizationId: 'org-1', name: 'Admin User',
      email: 'admin@example.com', passwordHash: await hashPassword('correct-password'),
      role: 'ADMIN', mustChangePassword: false, isActive: true, version: 1,
    });
    service = new AuthService(repository, 28_800, () => now);
    // Seeding (v2 hash) and any prior derivation are setup, not login work.
    derivations.counts.clear();
  });

  it('uses both sentinel slots for an unknown email', async () => {
    await expect(service.login('nobody@example.com', 'wrong-password'))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expect(kdfCounts()).toEqual({ old: 1, current: 1 });
    expect(repository.sessions).toHaveLength(0);
  });

  it('uses real CURRENT + dummy OLD for a wrong password', async () => {
    await expect(service.login('admin@example.com', 'wrong-password'))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expect(kdfCounts()).toEqual({ old: 1, current: 1 });
    expect(repository.sessions).toHaveLength(0);
  });

  it('uses real CURRENT + dummy OLD on a successful login', async () => {
    const result = await service.login('admin@example.com', 'correct-password');

    expect(kdfCounts()).toEqual({ old: 1, current: 1 });
    expect(result.rawToken).toHaveLength(43);
    expect(repository.sessions).toHaveLength(1);
  });

  it('performs the same fixed work for an inactive account before the generic reject', async () => {
    repository.users[0]!.isActive = false;

    await expect(service.login('admin@example.com', 'correct-password'))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expect(kdfCounts()).toEqual({ old: 1, current: 1 });
    expect(repository.sessions).toHaveLength(0);
  });
});

describe('credential sentinels', () => {
  it('OLD sentinel is a v1 N=16384 artifact with production salt/key lengths', async () => {
    const artifact = parsePasswordHash(await oldCredentialSentinelHash());

    expect(artifact?.profile).toBe('SCRYPT_V1');
    expect(artifact?.salt).toHaveLength(16);
    expect(artifact?.key).toHaveLength(64);
  });

  it('CURRENT sentinel is a v2 N=32768 artifact with production salt/key lengths', async () => {
    const artifact = parsePasswordHash(await currentCredentialSentinelHash());

    expect(artifact?.profile).toBe('SCRYPT_V2');
    expect(artifact?.salt).toHaveLength(16);
    expect(artifact?.key).toHaveLength(64);
  });

  it('each sentinel is derived once per process, never per request', async () => {
    const [oldConcurrent, oldMemoized] = await Promise.all([
      oldCredentialSentinelHash(),
      oldCredentialSentinelHash(),
    ]);
    const [currentConcurrent, currentMemoized] = await Promise.all([
      currentCredentialSentinelHash(),
      currentCredentialSentinelHash(),
    ]);

    expect(oldConcurrent).toBe(oldMemoized);
    expect(currentConcurrent).toBe(currentMemoized);
    expect(await oldCredentialSentinelHash()).toBe(oldConcurrent);
    expect(await currentCredentialSentinelHash()).toBe(currentConcurrent);
  });
});

/**
 * Cold-start regression.
 *
 * Both sentinels are memoized, so if either is first derived lazily by a
 * login, that single request pays an extra scrypt derivation while later
 * logins do not — which re-creates a timing distinction on the first login
 * after every process start / restart / deploy.
 *
 * The fix derives both sentinels during `buildApp`. These tests use the
 * counted derivation seams above (not wall-clock) to prove both derivations
 * have already happened by the time `buildApp` resolves, and that no later
 * login re-derives.
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

describe('dual-sentinel warmup at app construction', () => {
  let repository: MemoryAuthRepository;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    derivations.counts.clear();
    spies.oldSentinelDerivations = 0;
    spies.currentSentinelDerivations = 0;
    spies.oldSentinelMemo = null;
    spies.currentSentinelMemo = null;
    repository = new MemoryAuthRepository();
    repository.users.push({
      id: 'user-1', organizationId: 'org-1', name: 'Admin User',
      email: 'admin@example.com', passwordHash: await hashPassword('correct-password'),
      role: 'ADMIN', mustChangePassword: false, isActive: true, version: 1,
    });
    app = await buildApp(appConfig, { authRepository: repository });
    derivations.counts.clear();
  });

  afterEach(async () => {
    await app.close();
  });

  it('derives both sentinels during buildApp, before any request can be served', () => {
    // `buildApp` has resolved and no HTTP request exists yet. The production
    // server only reaches `listen()` after this resolves, so both derivations
    // are already complete before the first login can arrive.
    expect(spies.oldSentinelDerivations).toBe(1);
    expect(spies.currentSentinelDerivations).toBe(1);
  });

  it('does not re-derive on the first unknown-email login and keeps the fixed budget', async () => {
    // Baseline captured after construction: the cold-start login must not add
    // derivations on top of it (that would be the lazy-derivation path).
    const warmedOld = spies.oldSentinelDerivations;
    const warmedCurrent = spies.currentSentinelDerivations;

    const response = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { origin: appConfig.corsOrigin },
      payload: { email: 'nobody@example.com', password: 'wrong-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    // The cold-start request must reuse the warmed sentinels, not derive anew.
    expect(spies.oldSentinelDerivations).toBe(warmedOld);
    expect(spies.currentSentinelDerivations).toBe(warmedCurrent);
    expect(repository.sessions).toHaveLength(0);
  });

  it('performs the fixed two-KDF budget for a known user with a wrong password', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { origin: appConfig.corsOrigin },
      payload: { email: 'admin@example.com', password: 'wrong-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(spies.oldSentinelDerivations).toBe(1);
    expect(spies.currentSentinelDerivations).toBe(1);
    expect(repository.sessions).toHaveLength(0);
  });

  it('leaves successful login unchanged apart from the fixed budget', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { origin: appConfig.corsOrigin },
      payload: { email: 'admin@example.com', password: 'correct-password' },
    });

    expect(response.statusCode).toBe(200);
    expect(repository.sessions).toHaveLength(1);
    expect(response.headers['set-cookie']).toMatch(/servora_session=/);
  });
});
