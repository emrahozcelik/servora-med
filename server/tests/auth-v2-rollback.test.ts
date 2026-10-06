import { describe, expect, it } from 'vitest';
import { scryptSync } from 'node:crypto';

/**
 * R2 rollback contract: R1 (`19cfb2ab5511e3ff58a4dad3f64e137e6b05501f`) is
 * the mandatory rollback floor once any V2 credential exists — it can read
 * and verify V2 but writes only V1. Rolling back to a pre-R1 release
 * (`e4519b041fad136f98195cf79aecb21898fd6e9e`) is UNSAFE after R2 writes V2.
 *
 * Under R2: V2 holders authenticate normally with zero rewrite (V2 is not an
 * upgrade candidate), there is no downgrade, and policy-invalid historical
 * passwords still authenticate while transparently upgrading to V2.
 */
import {
  hashPassword,
  parsePasswordHash,
  passwordHashNeedsUpgrade,
  verifyPassword,
} from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import { AuthService } from '../src/modules/auth/service.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';

const V2_PASSWORD = 'Rollback-V2-Probe-2026!';
const LEGACY_PASSWORD = 'legacy-password';

function buildArtifact(
  password: string,
  version: '' | 'v1' | 'v2',
  cost: number,
  saltBytes: number[],
): string {
  const salt = Buffer.from(saltBytes);
  const key = scryptSync(password, salt, 64, { N: cost, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', ...(version ? [version] : []), cost, 8, 1,
    salt.toString('base64url'), key.toString('base64url')].join('$');
}

const SALT = [7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7];
const genuineV2 = () => buildArtifact(V2_PASSWORD, 'v2', 32768, SALT);

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
    this.upgradeCalls += 1;
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user || !user.isActive || user.passwordHash !== expectedPasswordHash) return 'conflict';
    user.passwordHash = replacementPasswordHash;
    return 'updated';
  }
}

function seedUser(passwordHash: string): { repository: MemoryRepository; service: AuthService } {
  const repository = new MemoryRepository();
  repository.users.push({
    id: 'user-1', organizationId: 'org-1', name: 'V2 Holder',
    email: 'holder@example.com', passwordHash,
    role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
  });
  const service = new AuthService(repository, 28_800, () => new Date('2026-10-01T08:00:00.000Z'));
  return { repository, service };
}

describe('R2 V2 holder contract', () => {
  it('authenticates the correct password, byte-identical hash, session issued, no rewrite', async () => {
    const v2 = genuineV2();
    expect(parsePasswordHash(v2)).toMatchObject({ profile: 'SCRYPT_V2' });
    const { repository, service } = seedUser(v2);

    const result = await service.login('holder@example.com', V2_PASSWORD);

    expect(result.rawToken).toHaveLength(43);
    expect(result.user.email).toBe('holder@example.com');
    expect(repository.sessions).toHaveLength(1);
    // V2 is final: no upgrade candidate, no CAS write.
    expect(repository.upgradeCalls).toBe(0);
    expect(repository.users[0]!.passwordHash).toBe(v2);
  });

  it('wrong password is a generic 401, never a 500, no mutation', async () => {
    const v2 = genuineV2();
    const { repository, service } = seedUser(v2);

    await expect(service.login('holder@example.com', 'Wrong-Password-2026!'))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expect(repository.sessions).toHaveLength(0);
    expect(repository.upgradeCalls).toBe(0);
    expect(repository.users[0]!.passwordHash).toBe(v2);
  });

  it('verifyPassword never throws for V2 paths', async () => {
    const v2 = genuineV2();
    await expect(verifyPassword(V2_PASSWORD, v2)).resolves.toBe(true);
    await expect(verifyPassword('Wrong-Password-2026!', v2)).resolves.toBe(false);
    await expect(verifyPassword(V2_PASSWORD, 'scrypt$v2$1$8$1$c2FsdA$a2V5')).resolves.toBe(false);
  });

  it('V2 is never an upgrade candidate and needs no rehash', async () => {
    expect(passwordHashNeedsUpgrade(genuineV2())).toBe(false);
  });

  it('password change under R2 emits V2', async () => {
    const v2 = genuineV2();
    const { repository, service } = seedUser(v2);

    await service.changePassword('user-1', V2_PASSWORD, 'Fresh-Rotation-2026!');

    const rotated = repository.users[0]!.passwordHash;
    expect(rotated).toMatch(/^scrypt\$v2\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(parsePasswordHash(rotated)).toMatchObject({ profile: 'SCRYPT_V2' });
    await expect(verifyPassword('Fresh-Rotation-2026!', rotated)).resolves.toBe(true);
  });

  it('hashPassword never emits LEGACY or V1', async () => {
    for (let i = 0; i < 3; i += 1) {
      const emitted = await hashPassword('Writer-Probe-2026!');
      expect(emitted).not.toContain('$v1$');
      expect(parsePasswordHash(emitted)).toMatchObject({ profile: 'SCRYPT_V2' });
    }
  });
});

describe('historical-password boundary under R2', () => {
  it.each([
    ['legacy', ''],
    ['v1', 'v1'],
    ['v2', 'v2'],
  ])('policy-violating historical password authenticates under %s and upgrades to V2', async (
    _label: string,
    version: '' | 'v1' | 'v2',
  ) => {
    // 'legacy-password' fails today's composition (no uppercase/digit/symbol).
    const cost = version === 'v2' ? 32768 : 16384;
    const historical = buildArtifact(LEGACY_PASSWORD, version, cost, SALT);
    const { repository, service } = seedUser(historical);

    const result = await service.login('holder@example.com', LEGACY_PASSWORD);

    expect(result.rawToken).toHaveLength(43);
    expect(repository.sessions).toHaveLength(1);
    expect(repository.users[0]!.mustChangePassword).toBe(false);
    const stored = repository.users[0]!.passwordHash;
    if (version === 'v2') {
      // Already final: no rewrite, same bytes.
      expect(repository.upgradeCalls).toBe(0);
      expect(stored).toBe(historical);
    } else {
      // Transparent upgrade; the SAME plaintext still authenticates.
      expect(repository.upgradeCalls).toBe(1);
      expect(parsePasswordHash(stored)).toMatchObject({ profile: 'SCRYPT_V2' });
    }
    await expect(verifyPassword(LEGACY_PASSWORD, stored)).resolves.toBe(true);
  });
});
