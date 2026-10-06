import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scryptSync } from 'node:crypto';

/**
 * R2 candidate-derivation failure contract.
 *
 * The V2 upgrade candidate is maintenance work: if its derivation fails at
 * runtime (e.g. memory pressure on the VPS), a valid OLD credential must
 * still authenticate, no HTTP 500 may surface, and invalid attempts must stay
 * generic. The failure must not create an OLD-credential oracle.
 *
 * Seam: node:crypto `scrypt` fails ONLY for N=32768. N=16384 (OLD slot and
 * real verifications) keeps working, so the OLD path stays fully exercised.
 */
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
      if (options.N === 32768) {
        callback(new Error('simulated V2 derivation failure'));
        return;
      }
      return actual.scrypt(password as never, salt as never, keylen as never, options as never, callback as never);
    },
  };
});

import {
  parsePasswordHash,
  performLoginPasswordWork,
  verifyPassword,
} from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import { AuthService } from '../src/modules/auth/service.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';

const PASSWORD = 'Candidate-Failure-2026!';

function buildOldArtifact(password: string): string {
  const salt = Buffer.from([8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8]);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', 'v1', 16384, 8, 1,
    salt.toString('base64url'), key.toString('base64url')].join('$');
}

class MemoryRepository implements AuthRepository {
  users: AuthUserRecord[] = [];
  sessions: SessionRecord[] = [];
  upgradeCalls = 0;

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

  async findSessionWithUser() {
    return null;
  }

  async revokeSession() {}

  async updatePasswordAndRevokeSessions() {
    return false;
  }

  async upgradePasswordHashIfCurrent(): Promise<'updated' | 'conflict'> {
    this.upgradeCalls += 1;
    return 'conflict';
  }
}

function seedUser(passwordHash: string): {
  repository: MemoryRepository;
  service: AuthService;
} {
  const repository = new MemoryRepository();
  repository.users.push({
    id: 'user-1', organizationId: 'org-1', name: 'Candidate User',
    email: 'candidate@example.com', passwordHash,
    role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
  });
  const service = new AuthService(repository, 28_800, () => new Date('2026-10-01T08:00:00.000Z'));
  return { repository, service };
}

describe('V2 candidate derivation failure', () => {
  let repository: MemoryRepository;
  let service: AuthService;

  beforeEach(() => {
    ({ repository, service } = seedUser(buildOldArtifact(PASSWORD)));
  });

  it('OLD correct password still logs in (no 500), session issued, hash left for a later login', async () => {
    const result = await service.login('candidate@example.com', PASSWORD);

    expect(result.rawToken).toHaveLength(43);
    expect(repository.sessions).toHaveLength(1);
    expect(repository.upgradeCalls).toBe(0);
    expect(parsePasswordHash(repository.users[0]!.passwordHash)).toMatchObject({
      profile: 'SCRYPT_V1',
    });
  });

  it('OLD wrong password is a generic 401, never a 500', async () => {
    await expect(service.login('candidate@example.com', 'Wrong-Password-2026!'))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expect(repository.sessions).toHaveLength(0);
    expect(repository.upgradeCalls).toBe(0);
  });

  it('performLoginPasswordWork reports OLD matches with no candidate on failure', async () => {
    const work = await performLoginPasswordWork(PASSWORD, buildOldArtifact(PASSWORD));

    expect(work.credentialClass).toBe('OLD');
    expect(work.matches).toBe(true);
    expect(work.verifiedHash).toBeTruthy();
    expect(work.upgradeCandidateHash).toBeUndefined();
  });

  it('OLD verification is unaffected: verifyPassword still resolves true', async () => {
    const artifact = buildOldArtifact(PASSWORD);
    await expect(verifyPassword(PASSWORD, artifact)).resolves.toBe(true);
    await expect(verifyPassword('Wrong-Password-2026!', artifact)).resolves.toBe(false);
  });
});
