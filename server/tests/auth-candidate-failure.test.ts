import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Candidate-derivation failure normalization (P2).
 *
 * If the CURRENT-slot V2 candidate derivation fails at runtime (e.g. VPS
 * memory pressure), an OLD-profile login must behave exactly like every other
 * path — decision from the OLD verification, generic 401/200, no upgrade —
 * instead of leaking an OLD-credential oracle via 500.
 */
const gate = vi.hoisted(() => ({ failNextCurrentDerivation: false }));

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
      if (gate.failNextCurrentDerivation && options.N === 32768) {
        gate.failNextCurrentDerivation = false;
        callback(new Error('simulated KDF resource exhaustion'));
        return undefined;
      }
      return actual.scrypt(password as never, salt as never, keylen as never, options as never, callback as never);
    },
  };
});

import { scryptSync } from 'node:crypto';
import {
  currentCredentialSentinelHash,
  oldCredentialSentinelHash,
} from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import { AuthService } from '../src/modules/auth/service.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';

const PASSWORD = 'Candidate-Fail-2026!';

function oldArtifact(): string {
  const salt = Buffer.from([3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
  const key = scryptSync(PASSWORD, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', 16384, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
}

class FailureRepository implements AuthRepository {
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

  async upgradePasswordHashIfCurrent(): Promise<'updated' | 'conflict'> {
    return 'conflict';
  }
}

beforeAll(async () => {
  await oldCredentialSentinelHash();
  await currentCredentialSentinelHash();
});

beforeEach(() => {
  gate.failNextCurrentDerivation = false;
});

function seedService(legacy: string): { repository: FailureRepository; service: AuthService } {
  const repository = new FailureRepository();
  repository.users.push({
    id: 'user-1', organizationId: 'org-1', name: 'Failure User',
    email: 'failure@example.com', passwordHash: legacy, role: 'STAFF',
    mustChangePassword: false, isActive: true, version: 1,
  });
  return { repository, service: new AuthService(repository, 28_800, () => new Date()) };
}

describe('V2 candidate derivation failure', () => {
  it('OLD correct password still logs in (no 500), session issued, hash left for a later login', async () => {
    const legacy = oldArtifact();
    const { repository, service } = seedService(legacy);
    gate.failNextCurrentDerivation = true;

    const result = await service.login('failure@example.com', PASSWORD);

    expect(result.user.email).toBe('failure@example.com');
    expect(repository.sessions).toHaveLength(1);
    // No candidate, no upgrade — the stored OLD hash remains for a later login.
    expect(repository.users[0]?.passwordHash).toBe(legacy);
  });

  it('OLD wrong password is a generic 401, never a 500', async () => {
    const { service } = seedService(oldArtifact());
    gate.failNextCurrentDerivation = true;

    await expect(
      service.login('failure@example.com', 'Wrong-Password-2026!'),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });
  });
});
