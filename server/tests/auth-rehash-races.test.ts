import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scryptSync } from 'node:crypto';

/**
 * R2 rehash race and recovery matrix (memory repository with production CAS
 * semantics). Deterministic: no sleeps, no wall-clock. The `staleHashOnce`
 * hook models a second process that read the OLD credential before another
 * login upgraded it, so the session-CAS / recovery interleaving is exact.
 */
import {
  hashPassword,
  parsePasswordHash,
  verifyPassword,
} from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import { AuthService } from '../src/modules/auth/service.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';

const PASSWORD = 'Race-Probe-2026!';
const OTHER_PASSWORD = 'Admin-Reset-2026!';

function buildArtifact(
  password: string,
  version: '' | 'v1' | 'v2',
  saltBytes: number[],
): string {
  const salt = Buffer.from(saltBytes);
  const cost = version === 'v2' ? 32768 : 16384;
  const key = scryptSync(password, salt, 64, { N: cost, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', ...(version ? [version] : []), cost, 8, 1,
    salt.toString('base64url'), key.toString('base64url')].join('$');
}

const SALT = [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9];
const OLD = () => buildArtifact(PASSWORD, 'v1', SALT);

class RaceRepository implements AuthRepository {
  users: AuthUserRecord[] = [];
  sessions: SessionRecord[] = [];
  upgradeCalls = 0;
  sessionCasCalls = 0;
  findByIdCalls = 0;
  failNextUpgrade = false;
  throwOnUpgrade = false;
  /** When set, findUserByEmail returns this snapshot hash (stale reader). */
  staleHashOnce: string | null = null;

  async findUserByEmail(email: string) {
    const user = this.users.find((candidate) => candidate.email.toLowerCase() === email);
    if (!user) return null;
    if (this.staleHashOnce) {
      const stale = { ...user, passwordHash: this.staleHashOnce };
      this.staleHashOnce = null;
      return stale;
    }
    return user;
  }

  async findUserById(id: string) {
    this.findByIdCalls += 1;
    return this.users.find((candidate) => candidate.id === id) ?? null;
  }

  async createSessionIfCredentialCurrent(
    input: Omit<SessionRecord, 'id' | 'revokedAt'> & { expectedPasswordHash: string },
  ) {
    this.sessionCasCalls += 1;
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
    if (this.throwOnUpgrade) throw new Error('simulated upgrade storage failure');
    if (this.failNextUpgrade) {
      this.failNextUpgrade = false;
      return 'conflict';
    }
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user || !user.isActive || user.passwordHash !== expectedPasswordHash) return 'conflict';
    // Mirror production semantics: ONLY password_hash changes.
    user.passwordHash = replacementPasswordHash;
    return 'updated';
  }

  seed(passwordHash: string, overrides: Partial<AuthUserRecord> = {}) {
    this.users.push({
      id: 'user-1', organizationId: 'org-1', name: 'Race User',
      email: 'race@example.com', passwordHash,
      role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
      ...overrides,
    });
  }

  service() {
    return new AuthService(this, 28_800, () => new Date('2026-10-01T08:00:00.000Z'));
  }
}

describe('R2 upgrade convergence and recovery', () => {
  let repo: RaceRepository;

  beforeEach(() => {
    repo = new RaceRepository();
    repo.seed(OLD());
  });

  it('two simultaneous OLD logins converge to one valid V2 credential', async () => {
    const service = repo.service();
    // Login A reads and verifies OLD, creates its session, upgrades to V2.
    const first = await service.login('race@example.com', PASSWORD);
    expect(first.rawToken).toHaveLength(43);
    expect(repo.upgradeCalls).toBe(1);
    const upgraded = repo.users[0]!.passwordHash;
    expect(parsePasswordHash(upgraded)).toMatchObject({ profile: 'SCRYPT_V2' });

    // Login B is a stale reader: it verified the OLD credential before A's
    // upgrade committed, so its session CAS fails and bounded recovery must
    // re-verify the SAME password against the CURRENT stored hash.
    repo.staleHashOnce = OLD();
    repo.upgradeCalls = 0;
    const second = await service.login('race@example.com', PASSWORD);

    expect(second.rawToken).toHaveLength(43);
    expect(repo.sessions).toHaveLength(2);
    // No second upgrade write: the recovered session is already on V2.
    expect(repo.upgradeCalls).toBe(0);
    expect(repo.users[0]!.passwordHash).toBe(upgraded);
    await expect(verifyPassword(PASSWORD, repo.users[0]!.passwordHash)).resolves.toBe(true);
  });

  it('upgrade CAS conflict leaves the login successful', async () => {
    repo.failNextUpgrade = true;
    const service = repo.service();

    const result = await service.login('race@example.com', PASSWORD);

    expect(result.rawToken).toHaveLength(43);
    expect(repo.sessions).toHaveLength(1);
    // Upgrade lost the race; the OLD credential stays and login already won.
    expect(parsePasswordHash(repo.users[0]!.passwordHash)).toMatchObject({
      profile: 'SCRYPT_V1',
    });
  });

  it('concurrent admin reset to a DIFFERENT secret: recovery refuses the old password', async () => {
    const service = repo.service();
    // The stale reader verified OLD; meanwhile an admin reset committed a
    // DIFFERENT secret before the session CAS.
    repo.staleHashOnce = OLD();
    repo.users[0]!.passwordHash = buildArtifact(OTHER_PASSWORD, 'v2', [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
    repo.users[0]!.version = 5;
    repo.sessions.length = 0;

    await expect(service.login('race@example.com', PASSWORD))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expect(repo.sessions).toHaveLength(0);
    expect(repo.users[0]!.passwordHash).toBe(
      buildArtifact(OTHER_PASSWORD, 'v2', [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]),
    );
    expect(repo.upgradeCalls).toBe(0);
  });

  it('concurrent transparent rehash to the SAME secret: bounded recovery succeeds', async () => {
    const service = repo.service();
    const sameSecretV2 = buildArtifact(PASSWORD, 'v2', [6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6]);
    repo.staleHashOnce = OLD();
    // Another process already rehashed to V2 with the SAME secret and the row
    // was refreshed (new version; e.g. an unrelated profile update).
    repo.users[0]!.passwordHash = sameSecretV2;
    repo.users[0]!.version = 7;

    const result = await service.login('race@example.com', PASSWORD);

    expect(result.rawToken).toHaveLength(43);
    expect(repo.sessions).toHaveLength(1);
    // Session bound to the CURRENT (V2) hash, not the stale OLD hash.
    expect(repo.sessions[0]!.tokenHash).toBeTruthy();
    expect(repo.upgradeCalls).toBe(0);
    expect(repo.users[0]!.passwordHash).toBe(sameSecretV2);
  });

  it('recovery returns the refreshed SafeUser (no stale flags or version)', async () => {
    const service = repo.service();
    const sameSecretV2 = buildArtifact(PASSWORD, 'v2', [6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6]);
    repo.staleHashOnce = OLD();
    repo.users[0]!.passwordHash = sameSecretV2;
    repo.users[0]!.mustChangePassword = true;
    repo.users[0]!.version = 9;

    const result = await service.login('race@example.com', PASSWORD);

    // The refetched row is authoritative: newest flags and version.
    expect(result.user.mustChangePassword).toBe(true);
    expect(result.user.version).toBe(9);
  });

  it('recovery fails closed when the refetched row is inactive', async () => {
    const service = repo.service();
    const sameSecretV2 = buildArtifact(PASSWORD, 'v2', [6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6]);
    repo.staleHashOnce = OLD();
    repo.users[0]!.passwordHash = sameSecretV2;
    repo.users[0]!.isActive = false;

    await expect(service.login('race@example.com', PASSWORD))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expect(repo.sessions).toHaveLength(0);
  });

  it('recovery is a single bounded attempt: no retry loop', async () => {
    const service = repo.service();
    const sameSecretV2 = buildArtifact(PASSWORD, 'v2', [6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6]);
    repo.staleHashOnce = OLD();
    repo.users[0]!.passwordHash = sameSecretV2;

    await service.login('race@example.com', PASSWORD);

    // Initial CAS + exactly one recovery CAS; one refetch; no loop.
    expect(repo.sessionCasCalls).toBe(2);
    expect(repo.findByIdCalls).toBe(1);
  });

  it('operational upgrade failure after session creation keeps the login successful', async () => {
    repo.throwOnUpgrade = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = repo.service();

    try {
      const result = await service.login('race@example.com', PASSWORD);
      expect(result.rawToken).toHaveLength(43);
      expect(repo.sessions).toHaveLength(1);
      // Best-effort: failure leaves the OLD credential for a later login.
      expect(parsePasswordHash(repo.users[0]!.passwordHash)).toMatchObject({
        profile: 'SCRYPT_V1',
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, meta] = warn.mock.calls[0]!;
      expect(String(message)).toContain('Transparent password-hash upgrade failed');
      // No credential material in the warning payload.
      const serialized = JSON.stringify(meta);
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain(repo.users[0]!.passwordHash);
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves must_change_password through a successful transparent upgrade', async () => {
    repo.users[0]!.mustChangePassword = true;
    const service = repo.service();

    const result = await service.login('race@example.com', PASSWORD);

    expect(result.user.mustChangePassword).toBe(true);
    expect(repo.users[0]!.mustChangePassword).toBe(true);
    expect(parsePasswordHash(repo.users[0]!.passwordHash)).toMatchObject({
      profile: 'SCRYPT_V2',
    });
  });

  it('repeated login after upgrade is idempotent: no further write', async () => {
    const service = repo.service();
    await service.login('race@example.com', PASSWORD);
    expect(repo.upgradeCalls).toBe(1);
    const stored = repo.users[0]!.passwordHash;

    await service.login('race@example.com', PASSWORD);
    await service.login('race@example.com', PASSWORD);

    expect(repo.upgradeCalls).toBe(1);
    expect(repo.users[0]!.passwordHash).toBe(stored);
    expect(repo.sessions).toHaveLength(3);
  });
});
