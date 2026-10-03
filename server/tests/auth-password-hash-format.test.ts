import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  hashPassword,
  passwordHashNeedsUpgrade,
  parsePasswordHash,
  verifyPassword,
} from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import { AuthService } from '../src/modules/auth/service.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';

/**
 * Password-hash profiles.
 *
 * Grammar:
 *   LEGACY  := "scrypt" "$" N "$" r "$" p "$" saltB64u "$" keyB64u   (6 fields)
 *   V1      := "scrypt" "$" "v1" "$" N "$" r "$" p "$" saltB64u "$" keyB64u
 *   V2      := "scrypt" "$" "v2" "$" N "$" r "$" p "$" saltB64u "$" keyB64u
 * LEGACY/V1 use N=16384; V2 (provisional current) uses N=32768. r=8, p=1,
 * 16-byte salt, 64-byte key everywhere. Only these three profiles are allowed.
 */

const PASSWORD = 'Format-Agility-2026!';

/**
 * Test-local artifact builder. Uses node:crypto directly so legacy/V1
 * fixtures do NOT depend on the production emitter (which now emits V2 only).
 * This keeps the legacy-compatibility proof independent.
 */
function buildArtifact(
  password: string,
  version: '' | 'v1' | 'v2',
  N: number,
  saltBytes: number[],
): string {
  const salt = Buffer.from(saltBytes);
  const key = scryptSync(password, salt, 64, { N, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', ...(version ? [version] : []), N, 8, 1,
    salt.toString('base64url'), key.toString('base64url')].join('$');
}

const LEGACY_SALT = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const V1_SALT = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];

function legacyArtifact(password: string): string {
  return buildArtifact(password, '', 16384, LEGACY_SALT);
}

function v1Artifact(password: string): string {
  return buildArtifact(password, 'v1', 16384, V1_SALT);
}

describe('current versioned emission', () => {
  it('hashPassword emits only the canonical v2 format', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^scrypt\$v2\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(parsePasswordHash(hash)).toMatchObject({ profile: 'SCRYPT_V2' });
  });
});

describe('parsePasswordHash', () => {
  it('recognizes supported legacy, v1, and v2 artifacts', async () => {
    expect(parsePasswordHash(await hashPassword(PASSWORD))).toMatchObject({
      profile: 'SCRYPT_V2',
    });
    expect(parsePasswordHash(v1Artifact(PASSWORD))).toMatchObject({ profile: 'SCRYPT_V1' });
    expect(parsePasswordHash(legacyArtifact(PASSWORD))).toMatchObject({
      profile: 'LEGACY_SCRYPT',
    });
  });

  it.each([
    ['not-a-password-hash', 'single field'],
    ['scrypt$16384$8$1$salt', 'too few fields'],
    ['scrypt$16384$8$1$salt$key$extra', 'legacy too many fields'],
    ['scrypt$v1$16384$8$1$salt$key$extra', 'v1 too many fields'],
    ['scrypt$v2$32768$8$1$salt$key$extra', 'v2 too many fields'],
    ['md5$v1$16384$8$1$c2FsdA$a2V5', 'unknown algorithm'],
    ['scrypt$v3$16384$8$1$c2FsdA$a2V5', 'unknown version'],
    ['scrypt$v2$16384$8$1$c2FsdA$a2V5', 'v2 profile with legacy N'],
    ['scrypt$v2$65536$8$1$c2FsdA$a2V5', 'v2 profile with unknown N'],
    ['scrypt$32768$8$1$c2FsdA$a2V5', 'wrong N'],
    ['scrypt$16384$4$1$c2FsdA$a2V5', 'wrong r'],
    ['scrypt$16384$8$2$c2FsdA$a2V5', 'wrong p'],
    ['scrypt$v1$32768$8$1$c2FsdA$a2V5', 'current wrong N'],
  ])('rejects %s (%s)', (hash) => {
    expect(parsePasswordHash(hash)).toBeNull();
  });
});

describe('passwordHashNeedsUpgrade', () => {
  it('classifies legacy and v1 as upgradeable and v2 as final', async () => {
    expect(passwordHashNeedsUpgrade(legacyArtifact(PASSWORD))).toBe(true);
    expect(passwordHashNeedsUpgrade(v1Artifact(PASSWORD))).toBe(true);
    expect(passwordHashNeedsUpgrade(await hashPassword(PASSWORD))).toBe(false);
  });

  it('never classifies malformed artifacts as upgrade candidates', () => {
    for (const hash of [
      'not-a-password-hash',
      'scrypt$v2$16384$8$1$c2FsdA$a2V5',
      'scrypt$32768$8$1$c2FsdA$a2V5',
      '',
    ]) {
      expect(passwordHashNeedsUpgrade(hash)).toBe(false);
    }
  });
});

describe('verifyPassword matrix', () => {
  it('verifies legacy correct -> true, legacy wrong -> false', async () => {
    const legacy = legacyArtifact(PASSWORD);
    await expect(verifyPassword(PASSWORD, legacy)).resolves.toBe(true);
    await expect(verifyPassword('Wrong-Password-2026!', legacy)).resolves.toBe(false);
  });

  it('verifies v1 correct -> true, v1 wrong -> false', async () => {
    const v1 = v1Artifact(PASSWORD);
    await expect(verifyPassword(PASSWORD, v1)).resolves.toBe(true);
    await expect(verifyPassword('Wrong-Password-2026!', v1)).resolves.toBe(false);
  });

  it('verifies v2 correct -> true, v2 wrong -> false', async () => {
    const current = await hashPassword(PASSWORD);
    await expect(verifyPassword(PASSWORD, current)).resolves.toBe(true);
    await expect(verifyPassword('Wrong-Password-2026!', current)).resolves.toBe(false);
  });

  it.each([
    ['md5$v1$16384$8$1$c2FsdA$a2V5', 'unknown algorithm'],
    ['scrypt$v3$16384$8$1$c2FsdA$a2V5', 'unknown version'],
    ['scrypt$v2$16384$8$1$c2FsdA$a2V5', 'v2 profile with legacy N'],
    ['scrypt$32768$8$1$c2FsdA$a2V5', 'unsupported N'],
    ['scrypt$16384$4$1$c2FsdA$a2V5', 'unsupported r'],
    ['scrypt$16384$8$2$c2FsdA$a2V5', 'unsupported p'],
    ['scrypt$v1$32768$8$1$c2FsdA$a2V5', 'current unsupported N'],
    ['scrypt$16384$8$1$salt', 'bad field count'],
    ['scrypt$16384$8$1$!!!$!!!', 'bad salt/key'],
  ])('rejects %s (%s) without throwing', async (hash) => {
    await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(false);
  });
});

const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Flip the lowest bit of the final symbol: same decoded bytes, non-canonical text. */
function trailingBitAlias(canonical: string): string {
  const last = canonical[canonical.length - 1] ?? '';
  const value = BASE64URL_ALPHABET.indexOf(last);
  expect(value).toBeGreaterThanOrEqual(0);
  return `${canonical.slice(0, -1)}${BASE64URL_ALPHABET[value ^ 1]}`;
}

describe('canonical base64url enforcement', () => {
  it('rejects padded, standard-alphabet, invalid, and trailing-bit-alias fields', async () => {
    const legacy = legacyArtifact(PASSWORD);
    const [algo, n, r, p, canonicalSalt, canonicalKey] = legacy.split('$');
    const legacyWithSalt = (salt: string) => `${algo}$${n}$${r}$${p}$${salt}$${canonicalKey}`;

    const aliasSalt = trailingBitAlias(canonicalSalt);
    // Premise: the alias really decodes to the same bytes (decoder ignores
    // trailing bits), so only the round-trip check can reject it.
    expect(Buffer.from(aliasSalt, 'base64url').equals(Buffer.from(canonicalSalt, 'base64url'))).toBe(
      true,
    );
    expect(aliasSalt).not.toBe(canonicalSalt);

    const variants: Array<[string, string]> = [
      [legacyWithSalt(`${canonicalSalt}=`), 'padded salt'],
      [`${algo}$${n}$${r}$${p}$${canonicalSalt}$${canonicalKey}=`, 'padded key'],
      [legacyWithSalt(`+${canonicalSalt.slice(1)}`), 'standard-base64 + in salt'],
      [`${algo}$${n}$${r}$${p}$${canonicalSalt}$/${canonicalKey.slice(1)}`, 'standard-base64 / in key'],
      [legacyWithSalt(`!${canonicalSalt.slice(1)}`), 'invalid alphabet character'],
      [legacyWithSalt(aliasSalt), 'non-canonical trailing-bit alias'],
    ];
    for (const [hash, label] of variants) {
      expect(parsePasswordHash(hash), label).toBeNull();
      await expect(verifyPassword(PASSWORD, hash), label).resolves.toBe(false);
      expect(passwordHashNeedsUpgrade(hash), label).toBe(false);
    }
  });

  it('rejects padded and aliased fields in v2 artifacts', async () => {
    const current = await hashPassword(PASSWORD);
    const [algo, version, n, r, p, canonicalSalt, canonicalKey] = current.split('$');
    expect(version).toBe('v2');
    const v2With = (salt: string, k: string) =>
      `${algo}$${version}$${n}$${r}$${p}$${salt}$${k}`;

    for (const [hash, label] of [
      [v2With(`${canonicalSalt}=`, canonicalKey), 'v2 padded salt'],
      [v2With(canonicalSalt, `${canonicalKey}==`), 'v2 padded key'],
      [v2With(trailingBitAlias(canonicalSalt), canonicalKey), 'v2 trailing-bit alias salt'],
    ] as Array<[string, string]>) {
      expect(parsePasswordHash(hash), label).toBeNull();
      await expect(verifyPassword(PASSWORD, hash), label).resolves.toBe(false);
    }
  });
});

/** Minimal login repository: production CAS semantics mirrored, nothing more. */
class LoginMemoryRepository implements AuthRepository {
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

function buildLegacyUser(passwordHash: string): {
  repository: LoginMemoryRepository;
  service: AuthService;
} {
  const repository = new LoginMemoryRepository();
  repository.users.push({
    id: 'user-1',
    organizationId: 'org-1',
    name: 'Legacy User',
    email: 'legacy@example.com',
    passwordHash,
    role: 'STAFF',
    mustChangePassword: false,
    isActive: true,
    version: 1,
  });
  const service = new AuthService(repository, 28_800, () => new Date());
  return { repository, service };
}

describe('legacy login upgrade (transparent rehash after session)', () => {
  it('authenticates a legacy credential and upgrades it to v2', async () => {
    const legacyHash = legacyArtifact(PASSWORD);
    const { repository, service } = buildLegacyUser(legacyHash);

    const result = await service.login('legacy@example.com', PASSWORD);

    expect(result.user.email).toBe('legacy@example.com');
    expect(typeof result.rawToken).toBe('string');
    expect(repository.sessions).toHaveLength(1);
    const upgraded = repository.users[0]?.passwordHash ?? '';
    expect(upgraded).not.toBe(legacyHash);
    expect(parsePasswordHash(upgraded)).toMatchObject({ profile: 'SCRYPT_V2' });
    await expect(verifyPassword(PASSWORD, upgraded)).resolves.toBe(true);
  });

  it('rejects a wrong password against a legacy credential without mutation', async () => {
    const legacyHash = legacyArtifact(PASSWORD);
    const { repository, service } = buildLegacyUser(legacyHash);

    await expect(service.login('legacy@example.com', 'Wrong-Password-2026!')).rejects.toThrow();
    expect(repository.sessions).toHaveLength(0);
    expect(repository.users[0]?.passwordHash).toBe(legacyHash);
  });

  it('authenticates a v1 credential and upgrades it to v2', async () => {
    const v1Hash = v1Artifact(PASSWORD);
    const { repository, service } = buildLegacyUser(v1Hash);

    const result = await service.login('legacy@example.com', PASSWORD);

    expect(result.user.email).toBe('legacy@example.com');
    expect(typeof result.rawToken).toBe('string');
    const upgraded = repository.users[0]?.passwordHash ?? '';
    expect(parsePasswordHash(upgraded)).toMatchObject({ profile: 'SCRYPT_V2' });
  });

  it('authenticates a v2 credential and leaves the hash byte-identical', async () => {
    const currentHash = await hashPassword(PASSWORD);
    const { repository, service } = buildLegacyUser(currentHash);

    const result = await service.login('legacy@example.com', PASSWORD);

    expect(result.user.email).toBe('legacy@example.com');
    expect(typeof result.rawToken).toBe('string');
    expect(repository.users[0]?.passwordHash).toBe(currentHash);
  });
});
