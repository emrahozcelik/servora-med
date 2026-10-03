import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fixed-work login KDF budget (structural, never wall-clock).
 *
 * Every NORMAL login attempt must perform sequentially exactly:
 *   1 × OLD-class derivation (N=16384) AND 1 × CURRENT-class derivation (N=32768)
 * The seam is a counted wrapper around node:crypto scrypt keyed by N.
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

import {
  currentCredentialSentinelHash,
  hashPassword,
  oldCredentialSentinelHash,
  parsePasswordHash,
  performLoginPasswordWork,
  verifyPassword,
} from '../src/modules/auth/crypto.js';
import { AuthService } from '../src/modules/auth/service.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';
import { scryptSync } from 'node:crypto';

const PASSWORD = 'Fixed-Work-2026!';

function buildArtifact(password: string, version: '' | 'v1', saltBytes: number[]): string {
  const salt = Buffer.from(saltBytes);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', ...(version ? [version] : []), 16384, 8, 1,
    salt.toString('base64url'), key.toString('base64url')].join('$');
}

const LEGACY = () => buildArtifact(PASSWORD, '', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const V1 = () => buildArtifact(PASSWORD, 'v1', [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36]);

class WorkMemoryRepository implements AuthRepository {
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

  async updatePasswordAndRevokeSessions() {
    return false;
  }

  async upgradePasswordHashIfCurrent(
    userId: string,
    expectedPasswordHash: string,
    replacementPasswordHash: string,
  ): Promise<'updated' | 'conflict'> {
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user || user.passwordHash !== expectedPasswordHash) return 'conflict';
    user.passwordHash = replacementPasswordHash;
    return 'updated';
  }
}

function seedUser(passwordHash: string, isActive = true): {
  repository: WorkMemoryRepository;
  service: AuthService;
} {
  const repository = new WorkMemoryRepository();
  repository.users.push({
    id: 'user-1', organizationId: 'org-1', name: 'Work User',
    email: 'work@example.com', passwordHash, role: 'STAFF',
    mustChangePassword: false, isActive, version: 1,
  });
  return { repository, service: new AuthService(repository, 28_800, () => new Date()) };
}

function kdfCounts() {
  return {
    old: derivations.counts.get(16384) ?? 0,
    current: derivations.counts.get(32768) ?? 0,
  };
}

beforeEach(() => {
  derivations.counts.clear();
});

// Mirror production warmup: both sentinels are derived before HTTP serving,
// so their one-time derivation cost must not contaminate per-login budgets.
beforeAll(async () => {
  await oldCredentialSentinelHash();
  await currentCredentialSentinelHash();
  derivations.counts.clear();
});

describe('performLoginPasswordWork classification', () => {
  it('OLD correct: matches with reusable v2 candidate', async () => {
    const work = await performLoginPasswordWork(PASSWORD, LEGACY());
    expect(work.credentialClass).toBe('OLD');
    expect(work.matches).toBe(true);
    expect(work.verifiedHash).toBe(LEGACY());
    expect(parsePasswordHash(work.upgradeCandidateHash ?? '')).toMatchObject({
      profile: 'SCRYPT_V2',
    });
    expect(kdfCounts()).toEqual({ old: 1, current: 1 });
    await expect(verifyPassword(PASSWORD, work.upgradeCandidateHash ?? '')).resolves.toBe(true);
  });

  it('OLD wrong: derives candidate anyway, no match', async () => {
    const work = await performLoginPasswordWork('Wrong-Password-2026!', LEGACY());
    expect(work.credentialClass).toBe('OLD');
    expect(work.matches).toBe(false);
    expect(work.upgradeCandidateHash).toBeUndefined();
    expect(kdfCounts()).toEqual({ old: 1, current: 1 });
  });

  it('CURRENT correct/incorrect: dummy OLD + real CURRENT', async () => {
    const v2 = await hashPassword(PASSWORD);
    const hit = await performLoginPasswordWork(PASSWORD, v2);
    expect(hit.credentialClass).toBe('CURRENT');
    expect(hit.matches).toBe(true);
    expect(hit.upgradeCandidateHash).toBeUndefined();
    derivations.counts.clear();
    const miss = await performLoginPasswordWork('Wrong-Password-2026!', v2);
    expect(miss.credentialClass).toBe('CURRENT');
    expect(miss.matches).toBe(false);
    expect(kdfCounts()).toEqual({ old: 1, current: 1 });
  });

  it('unknown/malformed: dual-sentinel dummy work, no match', async () => {
    for (const stored of [null, 'not-a-hash', 'scrypt$v9$1$1$1$c2FsdA$a2V5']) {
      derivations.counts.clear();
      const work = await performLoginPasswordWork(PASSWORD, stored);
      expect(work.credentialClass).toBe('UNSUPPORTED');
      expect(work.matches).toBe(false);
      expect(kdfCounts()).toEqual({ old: 1, current: 1 });
    }
  });
});

describe('service login fixed budget', () => {
  it('UNKNOWN: 1 OLD dummy + 1 CURRENT dummy', async () => {
    const { service } = seedUser(LEGACY());
    await expect(service.login('nobody@example.com', PASSWORD)).rejects.toThrow();
    expect(kdfCounts()).toEqual({ old: 1, current: 1 });
  });

  it('OLD wrong: 1 OLD real + 1 CURRENT candidate, no session, no mutation', async () => {
    const legacy = LEGACY();
    const { repository, service } = seedUser(legacy);
    await expect(service.login('work@example.com', 'Wrong-Password-2026!')).rejects.toThrow();
    expect(kdfCounts()).toEqual({ old: 1, current: 1 });
    expect(repository.sessions).toHaveLength(0);
    expect(repository.users[0]?.passwordHash).toBe(legacy);
  });

  it('OLD correct: exactly 2 KDFs, session issued, hash upgraded to v2', async () => {
    const legacy = LEGACY();
    const { repository, service } = seedUser(legacy);
    const result = await service.login('work@example.com', PASSWORD);
    expect(result.user.email).toBe('work@example.com');
    expect(kdfCounts()).toEqual({ old: 1, current: 1 });
    expect(repository.sessions).toHaveLength(1);
    expect(parsePasswordHash(repository.users[0]?.passwordHash ?? '')).toMatchObject({
      profile: 'SCRYPT_V2',
    });
  });

  it('V2 wrong/correct: 1 OLD dummy + 1 CURRENT real each', async () => {
    const v2 = await hashPassword(PASSWORD);
    derivations.counts.clear();
    const { service } = seedUser(v2);
    await expect(service.login('work@example.com', 'Wrong-Password-2026!')).rejects.toThrow();
    expect(kdfCounts()).toEqual({ old: 1, current: 1 });
    derivations.counts.clear();
    await service.login('work@example.com', PASSWORD);
    expect(kdfCounts()).toEqual({ old: 1, current: 1 });
  });

  it('INACTIVE OLD/V2: same fixed work, generic reject, no session, no rehash', async () => {
    for (const hash of [LEGACY(), await hashPassword(PASSWORD)]) {
      derivations.counts.clear();
      const { repository, service } = seedUser(hash, false);
      await expect(service.login('work@example.com', PASSWORD)).rejects.toThrow();
      expect(kdfCounts()).toEqual({ old: 1, current: 1 });
      expect(repository.sessions).toHaveLength(0);
      expect(repository.users[0]?.passwordHash).toBe(hash);
    }
  });
});
