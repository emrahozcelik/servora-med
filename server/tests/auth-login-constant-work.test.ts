import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

vi.mock('../src/modules/auth/crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/auth/crypto.js')>();
  return {
    ...actual,
    async verifyPassword(password: string, storedHash: string) {
      spies.verifyPasswordCalls += 1;
      spies.storedHashes.push(storedHash);
      return actual.verifyPassword(password, storedHash);
    },
  };
});

import {
  hashPassword,
  invalidCredentialSentinelHash,
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

function parseScryptArtifact(hash: string) {
  const [algorithm, cost, blockSize, parallelization, salt, key] = hash.split('$');
  return {
    algorithm,
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelization: Number(parallelization),
    salt: Buffer.from(salt ?? '', 'base64url'),
    key: Buffer.from(key ?? '', 'base64url'),
  };
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
    const artifact = parseScryptArtifact(await invalidCredentialSentinelHash());

    expect(artifact.algorithm).toBe('scrypt');
    expect(artifact.cost).toBe(16_384);
    expect(artifact.blockSize).toBe(8);
    expect(artifact.parallelization).toBe(1);
    expect(artifact.salt).toHaveLength(16);
    expect(artifact.key).toHaveLength(64);
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
