import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Opportunistic-rehash race matrix (deterministic gates, never sleeps).
 *
 * Interleavings are forced by overriding repository seams: the override runs
 * the competing operation first and then proceeds, so each test proves one
 * exact ordering. KDF structure on the recovery path is counted through the
 * node:crypto scrypt seam keyed by N.
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

import { scryptSync } from 'node:crypto';
import {
  currentCredentialSentinelHash,
  hashPassword,
  oldCredentialSentinelHash,
  parsePasswordHash,
  verifyPassword,
} from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import { AuthService } from '../src/modules/auth/service.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';

const PASSWORD = 'Race-Probe-2026!';
const NEW_PASSWORD = 'Brand-New-2026!';

function oldArtifact(password: string): string {
  const salt = Buffer.from([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', 16384, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
}

class RaceRepository implements AuthRepository {
  users: AuthUserRecord[] = [];
  sessions: SessionRecord[] = [];
  rehashCalls: Array<{ expected: string; replacement: string }> = [];
  rehashShouldThrow = false;
  warnings: unknown[][] = [];
  /** Hook run at the start of the next session-CAS call (one-shot gate). */
  beforeSessionCas: (() => void | Promise<void>) | null = null;
  /** Hook run at the start of the next rehash-CAS call (one-shot gate). */
  beforeRehashCas: (() => void | Promise<void>) | null = null;

  constructor() {
    const warn = console.warn;
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      this.warnings.push(args);
      void warn;
    });
  }

  seed(passwordHash: string, overrides: Partial<AuthUserRecord> = {}) {
    this.users.push({
      id: 'user-1', organizationId: 'org-1', name: 'Race User',
      email: 'race@example.com', passwordHash, role: 'STAFF',
      mustChangePassword: false, isActive: true, version: 7,
      ...overrides,
    });
  }

  service() {
    return new AuthService(this, 28_800, () => new Date());
  }

  async findUserByEmail(email: string) {
    // Return a copy like the production row mapper: callers must never observe
    // later in-place mutations through a previously fetched record.
    const found = this.users.find((user) => user.email.toLowerCase() === email) ?? null;
    return found ? { ...found } : null;
  }

  async findUserById(id: string) {
    const found = this.users.find((user) => user.id === id) ?? null;
    return found ? { ...found } : null;
  }

  /** Direct mutable access for deterministic race gates (tests only). */
  liveUser(id: string): AuthUserRecord | undefined {
    return this.users.find((user) => user.id === id);
  }

  async createSessionIfCredentialCurrent(
    input: Omit<SessionRecord, 'id' | 'revokedAt'> & { expectedPasswordHash: string },
  ) {
    if (this.beforeSessionCas) {
      const gate = this.beforeSessionCas;
      this.beforeSessionCas = null;
      await gate();
    }
    const user = this.users.find((candidate) => candidate.id === input.userId);
    if (!user || !user.isActive || user.passwordHash !== input.expectedPasswordHash) {
      return null;
    }
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

  async findSessionWithUser() {
    return null;
  }

  async revokeSession() {}

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

  async upgradePasswordHashIfCurrent(
    userId: string,
    expectedPasswordHash: string,
    replacementPasswordHash: string,
  ): Promise<'updated' | 'conflict'> {
    if (this.beforeRehashCas) {
      const gate = this.beforeRehashCas;
      this.beforeRehashCas = null;
      await gate();
    }
    if (this.rehashShouldThrow) throw new Error('simulated rehash DB failure');
    this.rehashCalls.push({ expected: expectedPasswordHash, replacement: replacementPasswordHash });
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user || user.passwordHash !== expectedPasswordHash) return 'conflict';
    user.passwordHash = replacementPasswordHash;
    return 'updated';
  }
}

function kdfCounts() {
  return {
    old: derivations.counts.get(16384) ?? 0,
    current: derivations.counts.get(32768) ?? 0,
  };
}

beforeEach(() => {
  derivations.counts.clear();
  vi.restoreAllMocks();
});

// Mirror production warmup: sentinel one-time derivations are startup cost,
// never per-login budget.
beforeAll(async () => {
  await oldCredentialSentinelHash();
  await currentCredentialSentinelHash();
  derivations.counts.clear();
});

describe('R1 self password-change races', () => {
  it('R1A: change wins before session CAS -> no session, recovery reverify fails, generic reject', async () => {
    const legacy = oldArtifact(PASSWORD);
    const repo = new RaceRepository();
    repo.seed(legacy);
    const changedHash = await hashPassword(NEW_PASSWORD);
    // Gate: a concurrent self change commits before the login session CAS.
    repo.beforeSessionCas = async () => {
      await repo.updatePasswordAndRevokeSessions('user-1', legacy, changedHash, new Date());
    };

    await expect(repo.service().login('race@example.com', PASSWORD)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(repo.sessions).toHaveLength(0);
    // Recovery re-verified the OLD password against the NEW credential and
    // failed, so no session and no rehash of any kind.
    expect(repo.rehashCalls).toHaveLength(0);
    expect(repo.users[0]?.passwordHash).toBe(changedHash);
  });

  it('R1B: session CAS wins first -> session exists, later change revokes, rehash never overwrites', async () => {
    const legacy = oldArtifact(PASSWORD);
    const repo = new RaceRepository();
    repo.seed(legacy);
    const changedHash = await hashPassword(NEW_PASSWORD);
    // Gate: self change commits after session CAS but before rehash CAS.
    repo.beforeRehashCas = async () => {
      await repo.updatePasswordAndRevokeSessions('user-1', legacy, changedHash, new Date());
    };

    const result = await repo.service().login('race@example.com', PASSWORD);
    expect(typeof result.rawToken).toBe('string');
    expect(repo.sessions).toHaveLength(1);
    // The rehash CAS targeted the stale OLD hash and lost; real credential wins.
    expect(repo.users[0]?.passwordHash).toBe(changedHash);
    // Existing change semantics revoked the just-created session.
    expect(repo.sessions[0]?.revokedAt).not.toBeNull();
  });
});

describe('R2 admin-reset races', () => {
  it('R2A: reset wins before session CAS -> old password gets no session', async () => {
    const legacy = oldArtifact(PASSWORD);
    const repo = new RaceRepository();
    repo.seed(legacy);
    const resetHash = await hashPassword('Reset-Temp-2026!');
    repo.beforeSessionCas = async () => {
      await repo.updatePasswordAndRevokeSessions('user-1', legacy, resetHash, new Date());
    };

    await expect(repo.service().login('race@example.com', PASSWORD)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(repo.sessions).toHaveLength(0);
    expect(repo.rehashCalls).toHaveLength(0);
    expect(repo.users[0]?.passwordHash).toBe(resetHash);
  });

  it('R2B: session wins first -> later reset revokes, rehash never overwrites', async () => {
    const legacy = oldArtifact(PASSWORD);
    const repo = new RaceRepository();
    repo.seed(legacy);
    const resetHash = await hashPassword('Reset-Temp-2026!');
    repo.beforeRehashCas = async () => {
      await repo.updatePasswordAndRevokeSessions('user-1', legacy, resetHash, new Date());
    };

    await repo.service().login('race@example.com', PASSWORD);
    expect(repo.sessions).toHaveLength(1);
    expect(repo.users[0]?.passwordHash).toBe(resetHash);
    expect(repo.sessions[0]?.revokedAt).not.toBeNull();
  });
});

describe('R3/R6 simultaneous OLD logins', () => {
  it('R3: both valid callers obtain sessions, one rehash wins, final is v2', async () => {
    const legacy = oldArtifact(PASSWORD);
    const repo = new RaceRepository();
    repo.seed(legacy);
    const service = repo.service();

    const [first, second] = await Promise.all([
      service.login('race@example.com', PASSWORD),
      service.login('race@example.com', PASSWORD),
    ]);

    expect(typeof first.rawToken).toBe('string');
    expect(typeof second.rawToken).toBe('string');
    expect(repo.sessions).toHaveLength(2);
    const final = repo.users[0]?.passwordHash ?? '';
    expect(parsePasswordHash(final)).toMatchObject({ profile: 'SCRYPT_V2' });
    await expect(verifyPassword(PASSWORD, final)).resolves.toBe(true);
  });

  it('R6: loser of the session CAS recovers via reverify (exceptional extra CURRENT KDF), no destructive mutation', async () => {
    const legacy = oldArtifact(PASSWORD);
    const repo = new RaceRepository();
    repo.seed(legacy);
    // Precompute OUTSIDE the measured login: the gate only installs it.
    const upgraded = await hashPassword(PASSWORD);
    derivations.counts.clear();
    // Gate: another login transparently upgrades BEFORE this login's session CAS.
    repo.beforeSessionCas = async () => {
      const user = repo.liveUser('user-1');
      if (user) user.passwordHash = upgraded;
    };

    const result = await repo.service().login('race@example.com', PASSWORD);
    expect(typeof result.rawToken).toBe('string');
    expect(repo.sessions).toHaveLength(1);
    // Normal fixed budget (OLD real + CURRENT candidate) plus ONE exceptional
    // CURRENT re-verification on the recovery path — never a silent assumption.
    expect(kdfCounts()).toEqual({ old: 1, current: 2 });
    const final = repo.users[0]?.passwordHash ?? '';
    expect(parsePasswordHash(final)).toMatchObject({ profile: 'SCRYPT_V2' });
  });
});

describe('recovery returns the refreshed user record', () => {
  it('reset to the same password with must_change_password set surfaces the fresh flags', async () => {
    const legacy = oldArtifact(PASSWORD);
    const repo = new RaceRepository();
    repo.seed(legacy);
    const resetToSame = await hashPassword(PASSWORD);
    // Gate: admin resets to the SAME password (v2, must_change_password=TRUE)
    // after verification but before the initial session CAS.
    repo.beforeSessionCas = async () => {
      const user = repo.liveUser('user-1');
      if (user) {
        user.passwordHash = resetToSame;
        user.mustChangePassword = true;
      }
    };

    const result = await repo.service().login('race@example.com', PASSWORD);

    expect(repo.sessions).toHaveLength(1);
    // The response must carry the refreshed row, not the stale login-time row.
    expect(result.user.mustChangePassword).toBe(true);
    expect(repo.users[0]?.passwordHash).toBe(resetToSame);
  });
});

describe('policy-violating historical password', () => {
  it('transparently upgrades without running new-password policy or forced reset', async () => {
    // 'legacy-password' fails today's composition (no uppercase/digit/symbol).
    const salt = Buffer.from([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
    const key = scryptSync('legacy-password', salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
    const historical = ['scrypt', 16384, 8, 1,
      salt.toString('base64url'), key.toString('base64url')].join('$');
    const repo = new RaceRepository();
    repo.seed(historical);

    const result = await repo.service().login('race@example.com', 'legacy-password');

    expect(typeof result.rawToken).toBe('string');
    expect(repo.sessions).toHaveLength(1);
    expect(parsePasswordHash(repo.users[0]?.passwordHash ?? '')).toMatchObject({
      profile: 'SCRYPT_V2',
    });
    await expect(
      verifyPassword('legacy-password', repo.users[0]?.passwordHash ?? ''),
    ).resolves.toBe(true);
  });
});

describe('R4 deactivation', () => {  it('deactivation before session CAS -> no session, no rehash', async () => {
    const legacy = oldArtifact(PASSWORD);
    const repo = new RaceRepository();
    repo.seed(legacy);
    repo.beforeSessionCas = async () => {
      const user = repo.liveUser('user-1');
      if (user) user.isActive = false;
    };

    await expect(repo.service().login('race@example.com', PASSWORD)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(repo.sessions).toHaveLength(0);
    expect(repo.rehashCalls).toHaveLength(0);
    expect(repo.users[0]?.passwordHash).toBe(legacy);
  });
});

describe('R5 rehash operational failure', () => {
  it('session created, rehash throws -> login still succeeds, warning emitted, old hash may remain', async () => {
    const legacy = oldArtifact(PASSWORD);
    const repo = new RaceRepository();
    repo.seed(legacy);
    repo.rehashShouldThrow = true;

    const result = await repo.service().login('race@example.com', PASSWORD);
    expect(typeof result.rawToken).toBe('string');
    expect(repo.sessions).toHaveLength(1);
    expect(repo.users[0]?.passwordHash).toBe(legacy);
    expect(repo.warnings.length).toBeGreaterThan(0);
    const logged = JSON.stringify(repo.warnings[0]);
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(legacy);
  });
});

describe('R7/R8 rehash CAS contention', () => {
  it('R7: rehash loses to real password change -> new credential wins, login already succeeded', async () => {
    const legacy = oldArtifact(PASSWORD);
    const repo = new RaceRepository();
    repo.seed(legacy);
    const changedHash = await hashPassword(NEW_PASSWORD);
    repo.beforeRehashCas = async () => {
      await repo.updatePasswordAndRevokeSessions('user-1', legacy, changedHash, new Date());
    };

    await repo.service().login('race@example.com', PASSWORD);
    expect(repo.sessions).toHaveLength(1);
    expect(repo.users[0]?.passwordHash).toBe(changedHash);
  });

  it('R8: rehash loses to equivalent rehash -> login unaffected, final v2', async () => {
    const legacy = oldArtifact(PASSWORD);
    const repo = new RaceRepository();
    repo.seed(legacy);
    const otherV2 = await hashPassword(PASSWORD);
    repo.beforeRehashCas = async () => {
      const user = repo.liveUser('user-1');
      if (user) user.passwordHash = otherV2;
    };

    await repo.service().login('race@example.com', PASSWORD);
    expect(repo.sessions).toHaveLength(1);
    expect(repo.users[0]?.passwordHash).toBe(otherV2);
  });
});

describe('R9 mustChangePassword preservation', () => {
  it('legacy credential with mustChangePassword=true logs in, upgrades, flag and version untouched', async () => {
    const legacy = oldArtifact(PASSWORD);
    const repo = new RaceRepository();
    repo.seed(legacy, { mustChangePassword: true });

    const result = await repo.service().login('race@example.com', PASSWORD);
    expect(result.user.mustChangePassword).toBe(true);
    expect(repo.users[0]?.mustChangePassword).toBe(true);
    expect(repo.users[0]?.version).toBe(7);
    expect(parsePasswordHash(repo.users[0]?.passwordHash ?? '')).toMatchObject({
      profile: 'SCRYPT_V2',
    });
  });
});

describe('R10 malformed credential', () => {
  it('fixed two-KDF work, generic reject, no session, no mutation', async () => {
    const repo = new RaceRepository();
    repo.seed('scrypt$v9$1$1$1$c2FsdA$a2V5');

    await expect(repo.service().login('race@example.com', PASSWORD)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(kdfCounts()).toEqual({ old: 1, current: 1 });
    expect(repo.sessions).toHaveLength(0);
    expect(repo.rehashCalls).toHaveLength(0);
    expect(repo.users[0]?.passwordHash).toBe('scrypt$v9$1$1$1$c2FsdA$a2V5');
  });
});
