import { describe, expect, it } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';

/**
 * Password-hash format agility foundation (R2 writer flip).
 *
 * Grammar:
 *   LEGACY  := "scrypt" "$" N "$" r "$" p "$" saltB64u "$" keyB64u   (6 fields)
 *   V1      := "scrypt" "$" "v1" "$" N "$" r "$" p "$" saltB64u "$" keyB64u
 *   V2      := "scrypt" "$" "v2" "$" N "$" r "$" p "$" saltB64u "$" keyB64u
 * LEGACY/V1 use N=16384; V2 (the sole R2 writer) uses N=32768. r=8, p=1,
 * 16-byte salt, 64-byte key. Only these three profiles are allowed;
 * verification never executes arbitrary stored KDF parameters.
 */
import {
  hashPassword,
  passwordHashNeedsUpgrade,
  parsePasswordHash,
  verifyPassword,
} from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import { AuthService } from '../src/modules/auth/service.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';

const PASSWORD = 'Format-Agility-2026!';

/** Synthesize a genuine artifact for the given profile and password. */
function buildArtifact(password: string, version: '' | 'v1' | 'v2', salt: Buffer): string {
  const cost = version === 'v2' ? 32768 : 16384;
  const key = scryptSync(password, salt, 64, { N: cost, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', ...(version ? [version] : []), cost, 8, 1,
    salt.toString('base64url'), key.toString('base64url')].join('$');
}

const legacyArtifact = () => buildArtifact(PASSWORD, '', randomBytes(16));
const v1Artifact = () => buildArtifact(PASSWORD, 'v1', randomBytes(16));
const v2Artifact = () => buildArtifact(PASSWORD, 'v2', randomBytes(16));

describe('current versioned emission (R2 writer flip)', () => {
  it('hashPassword emits only the v2 format', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^scrypt\$v2\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(parsePasswordHash(hash)).toMatchObject({ profile: 'SCRYPT_V2' });
  });
});

describe('parsePasswordHash', () => {
  it('recognizes supported legacy, v1, and v2 artifacts', () => {
    expect(parsePasswordHash(legacyArtifact())).toMatchObject({ profile: 'LEGACY_SCRYPT' });
    expect(parsePasswordHash(v1Artifact())).toMatchObject({ profile: 'SCRYPT_V1' });
    expect(parsePasswordHash(v2Artifact())).toMatchObject({ profile: 'SCRYPT_V2' });
  });

  it.each([
    ['not-a-password-hash', 'single field'],
    ['scrypt$16384$8$1$salt', 'too few fields'],
    ['scrypt$16384$8$1$salt$key$extra', 'legacy too many fields'],
    ['scrypt$v1$16384$8$1$salt$key$extra', 'v1 too many fields'],
    ['scrypt$v2$32768$8$1$salt$key$extra', 'v2 too many fields'],
    ['md5$v1$16384$8$1$c2FsdA$a2V5', 'unknown algorithm'],
    ['scrypt$v3$16384$8$1$c2FsdA$a2V5', 'unknown version'],
    ['scrypt$v2$16384$8$1$c2FsdA$a2V5', 'v2 with legacy cost'],
    ['scrypt$v2$65536$8$1$c2FsdA$a2V5', 'v2 with arbitrary cost'],
    ['scrypt$v2$32768$4$1$c2FsdA$a2V5', 'v2 wrong r'],
    ['scrypt$v2$32768$8$2$c2FsdA$a2V5', 'v2 wrong p'],
    ['scrypt$32768$8$1$c2FsdA$a2V5', 'unsupported N'],
    ['scrypt$16384$4$1$c2FsdA$a2V5', 'wrong r'],
    ['scrypt$16384$8$2$c2FsdA$a2V5', 'wrong p'],
    ['scrypt$v1$32768$8$1$c2FsdA$a2V5', 'v1 with v2 cost'],
  ])('rejects %s (%s)', (hash) => {
    expect(parsePasswordHash(hash)).toBeNull();
  });
});

describe('passwordHashNeedsUpgrade', () => {
  it('classifies legacy and v1 as upgradeable and v2 as final', () => {
    expect(passwordHashNeedsUpgrade(legacyArtifact())).toBe(true);
    expect(passwordHashNeedsUpgrade(v1Artifact())).toBe(true);
    expect(passwordHashNeedsUpgrade(v2Artifact())).toBe(false);
  });

  it('never classifies malformed artifacts as upgrade candidates', () => {
    for (const hash of [
      'not-a-password-hash',
      'scrypt$v3$16384$8$1$c2FsdA$a2V5',
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
    const legacy = legacyArtifact();
    await expect(verifyPassword(PASSWORD, legacy)).resolves.toBe(true);
    await expect(verifyPassword('Wrong-Password-2026!', legacy)).resolves.toBe(false);
  });

  it('verifies v1 correct -> true, v1 wrong -> false', async () => {
    const v1 = v1Artifact();
    await expect(verifyPassword(PASSWORD, v1)).resolves.toBe(true);
    await expect(verifyPassword('Wrong-Password-2026!', v1)).resolves.toBe(false);
  });

  it('verifies v2 correct -> true, v2 wrong -> false (writer output included)', async () => {
    const v2 = await hashPassword(PASSWORD);
    await expect(verifyPassword(PASSWORD, v2)).resolves.toBe(true);
    await expect(verifyPassword('Wrong-Password-2026!', v2)).resolves.toBe(false);
  });

  it.each([
    ['md5$v1$16384$8$1$c2FsdA$a2V5', 'unknown algorithm'],
    ['scrypt$v3$16384$8$1$c2FsdA$a2V5', 'unknown version'],
    ['scrypt$v2$16384$8$1$c2FsdA$a2V5', 'v2 with legacy cost'],
    ['scrypt$32768$8$1$c2FsdA$a2V5', 'unsupported N'],
    ['scrypt$16384$4$1$c2FsdA$a2V5', 'unsupported r'],
    ['scrypt$16384$8$2$c2FsdA$a2V5', 'unsupported p'],
    ['scrypt$v1$32768$8$1$c2FsdA$a2V5', 'v1 with v2 cost'],
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
    const legacy = legacyArtifact();
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

  it('rejects padded and aliased fields in v1 artifacts', () => {
    const v1 = v1Artifact();
    const [algo, version, n, r, p, canonicalSalt, canonicalKey] = v1.split('$');
    const v1With = (salt: string, k: string) =>
      `${algo}$${version}$${n}$${r}$${p}$${salt}$${k}`;

    for (const [hash, label] of [
      [v1With(`${canonicalSalt}=`, canonicalKey), 'v1 padded salt'],
      [v1With(canonicalSalt, `${canonicalKey}==`), 'v1 padded key'],
      [v1With(trailingBitAlias(canonicalSalt), canonicalKey), 'v1 trailing-bit alias salt'],
    ] as Array<[string, string]>) {
      expect(parsePasswordHash(hash), label).toBeNull();
    }
  });

  it('rejects padded and aliased fields in v2 artifacts', async () => {
    const v2 = await hashPassword(PASSWORD);
    const [algo, version, n, r, p, canonicalSalt, canonicalKey] = v2.split('$');
    const v2With = (salt: string, k: string) =>
      `${algo}$${version}$${n}$${r}$${p}$${salt}$${k}`;

    for (const [hash, label] of [
      [v2With(`${canonicalSalt}=`, canonicalKey), 'v2 padded salt'],
      [v2With(canonicalSalt, `${canonicalKey}==`), 'v2 padded key'],
      [v2With(trailingBitAlias(canonicalSalt), canonicalKey), 'v2 trailing bit alias salt'],
    ] as Array<[string, string]>) {
      expect(parsePasswordHash(hash), label).toBeNull();
      await expect(verifyPassword(PASSWORD, hash), label).resolves.toBe(false);
      expect(passwordHashNeedsUpgrade(hash), label).toBe(false);
    }
  });
});

/** Minimal login repository: production CAS semantics mirrored, nothing more. */
class LoginMemoryRepository implements AuthRepository {
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
    this.upgradeCalls += 1;
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user || !user.isActive || user.passwordHash !== expectedPasswordHash) return 'conflict';
    user.passwordHash = replacementPasswordHash;
    return 'updated';
  }
}

function buildUser(passwordHash: string): {
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

describe('transparent upgrade after successful login (R2)', () => {
  it('authenticates a legacy credential and upgrades it to v2', async () => {
    const legacyHash = legacyArtifact();
    const { repository, service } = buildUser(legacyHash);

    const result = await service.login('legacy@example.com', PASSWORD);

    expect(result.user.email).toBe('legacy@example.com');
    expect(typeof result.rawToken).toBe('string');
    expect(repository.sessions).toHaveLength(1);
    expect(repository.upgradeCalls).toBe(1);
    const stored = repository.users[0]!.passwordHash;
    expect(parsePasswordHash(stored)).toMatchObject({ profile: 'SCRYPT_V2' });
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
  });

  it('rejects a wrong password against a legacy credential without mutation', async () => {
    const legacyHash = legacyArtifact();
    const { repository, service } = buildUser(legacyHash);

    await expect(service.login('legacy@example.com', 'Wrong-Password-2026!')).rejects.toThrow();
    expect(repository.sessions).toHaveLength(0);
    expect(repository.upgradeCalls).toBe(0);
    expect(repository.users[0]!.passwordHash).toBe(legacyHash);
  });

  it('authenticates a v1 credential and upgrades it to v2', async () => {
    const v1Hash = v1Artifact();
    const { repository, service } = buildUser(v1Hash);

    const result = await service.login('legacy@example.com', PASSWORD);

    expect(result.user.email).toBe('legacy@example.com');
    expect(typeof result.rawToken).toBe('string');
    expect(repository.upgradeCalls).toBe(1);
    const stored = repository.users[0]!.passwordHash;
    expect(parsePasswordHash(stored)).toMatchObject({ profile: 'SCRYPT_V2' });
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
  });

  it('V2 login performs no upgrade write and stores no new hash', async () => {
    const v2Hash = await hashPassword(PASSWORD);
    const { repository, service } = buildUser(v2Hash);

    await service.login('legacy@example.com', PASSWORD);

    expect(repository.upgradeCalls).toBe(0);
    expect(repository.users[0]!.passwordHash).toBe(v2Hash);
  });
});
