import { describe, expect, it } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';

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
 * Password-hash format agility foundation (R1 reader-first).
 *
 * Grammar:
 *   LEGACY  := "scrypt" "$" N "$" r "$" p "$" saltB64u "$" keyB64u   (6 fields)
 *   V1      := "scrypt" "$" "v1" "$" N "$" r "$" p "$" saltB64u "$" keyB64u
 *   V2      := "scrypt" "$" "v2" "$" N "$" r "$" p "$" saltB64u "$" keyB64u
 * LEGACY/V1 use N=16384; V2 uses N=32768. r=8, p=1, 16-byte salt, 64-byte key.
 * Only these three profiles are allowed; verification never executes arbitrary
 * stored KDF parameters. R1 reads V2 but emits ONLY V1 (no rehash).
 */

const PASSWORD = 'Format-Agility-2026!';

/** Synthesize a genuine legacy artifact from a versioned hash (same bytes). */
function toLegacyFormat(versionedHash: string): string {
  const parts = versionedHash.split('$');
  expect(parts[1]).toBe('v1');
  return ['scrypt', ...parts.slice(2)].join('$');
}

/** Synthesize a genuine V2 artifact (N=32768) for the given password. */
function toV2Format(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', 'v2', 32768, 8, 1,
    salt.toString('base64url'), key.toString('base64url')].join('$');
}

describe('current versioned emission', () => {
  it('hashPassword emits only the v1 format', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^scrypt\$v1\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(parsePasswordHash(hash)).toMatchObject({ profile: 'SCRYPT_V1' });
  });
});
describe('parsePasswordHash', () => {
  it('recognizes supported legacy and current artifacts', async () => {
    const current = await hashPassword(PASSWORD);
    expect(parsePasswordHash(current)).toMatchObject({ profile: 'SCRYPT_V1' });
    expect(parsePasswordHash(toLegacyFormat(current))).toMatchObject({
      profile: 'LEGACY_SCRYPT',
    });
  });

  it.each([
    ['not-a-password-hash', 'single field'],
    ['scrypt$16384$8$1$salt', 'too few fields'],
    ['scrypt$16384$8$1$salt$key$extra', 'legacy too many fields'],
    ['scrypt$v1$16384$8$1$salt$key$extra', 'current too many fields'],
    ['md5$v1$16384$8$1$c2FsdA$a2V5', 'unknown algorithm'],
    ['scrypt$v3$16384$8$1$c2FsdA$a2V5', 'unknown version'],
    ['scrypt$v2$16384$8$1$c2FsdA$a2V5', 'v2 with legacy cost'],
    ['scrypt$v2$65536$8$1$c2FsdA$a2V5', 'v2 with arbitrary cost'],
    ['scrypt$v2$32768$4$1$c2FsdA$a2V5', 'v2 wrong r'],
    ['scrypt$v2$32768$8$2$c2FsdA$a2V5', 'v2 wrong p'],
    ['scrypt$v2$32768$8$1$c2FsdA$a2V5$extra', 'v2 too many fields'],
    ['scrypt$32768$8$1$c2FsdA$a2V5', 'wrong N'],
    ['scrypt$16384$4$1$c2FsdA$a2V5', 'wrong r'],
    ['scrypt$16384$8$2$c2FsdA$a2V5', 'wrong p'],
    ['scrypt$v1$32768$8$1$c2FsdA$a2V5', 'current wrong N'],
  ])('rejects %s (%s)', (hash) => {
    expect(parsePasswordHash(hash)).toBeNull();
  });
});

describe('passwordHashNeedsUpgrade', () => {
  it('classifies legacy as upgradeable and current as final', async () => {
    const current = await hashPassword(PASSWORD);
    expect(passwordHashNeedsUpgrade(toLegacyFormat(current))).toBe(true);
    expect(passwordHashNeedsUpgrade(current)).toBe(false);
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

  it('never classifies v1 or v2 artifacts as upgrade candidates (R1 performs no rehash)', async () => {
    expect(passwordHashNeedsUpgrade(await hashPassword(PASSWORD))).toBe(false);
    expect(passwordHashNeedsUpgrade(toV2Format(PASSWORD))).toBe(false);
  });
});

describe('verifyPassword matrix', () => {
  it('verifies legacy correct -> true, legacy wrong -> false', async () => {
    const legacy = toLegacyFormat(await hashPassword(PASSWORD));
    await expect(verifyPassword(PASSWORD, legacy)).resolves.toBe(true);
    await expect(verifyPassword('Wrong-Password-2026!', legacy)).resolves.toBe(false);
  });

  it('verifies current correct -> true, current wrong -> false', async () => {
    const current = await hashPassword(PASSWORD);
    await expect(verifyPassword(PASSWORD, current)).resolves.toBe(true);
    await expect(verifyPassword('Wrong-Password-2026!', current)).resolves.toBe(false);
  });

  it('recognizes and verifies a genuine v2 artifact (R1 reader)', async () => {
    const v2 = toV2Format(PASSWORD);
    expect(v2).toMatch(/^scrypt\$v2\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(parsePasswordHash(v2)).toMatchObject({ profile: 'SCRYPT_V2' });
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
    const current = await hashPassword(PASSWORD);
    const [, , , , , canonicalSalt, canonicalKey] = current.split('$');
    const legacyBase = toLegacyFormat(current);
    const [algo, n, r, p, , key] = legacyBase.split('$');
    const legacyWithSalt = (salt: string) => `${algo}$${n}$${r}$${p}$${salt}$${key}`;

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

  it('rejects padded and aliased fields in v1 artifacts', async () => {
    const current = await hashPassword(PASSWORD);
    const [algo, version, n, r, p, canonicalSalt, canonicalKey] = current.split('$');
    const v1With = (salt: string, k: string) =>
      `${algo}$${version}$${n}$${r}$${p}$${salt}$${k}`;

    for (const [hash, label] of [
      [v1With(`${canonicalSalt}=`, canonicalKey), 'v1 padded salt'],
      [v1With(canonicalSalt, `${canonicalKey}==`), 'v1 padded key'],
      [v1With(trailingBitAlias(canonicalSalt), canonicalKey), 'v1 trailing-bit alias salt'],
    ] as Array<[string, string]>) {
      expect(parsePasswordHash(hash), label).toBeNull();
      await expect(verifyPassword(PASSWORD, hash), label).resolves.toBe(false);
    }
  });

  it('rejects padded and aliased fields in v2 artifacts', async () => {
    const v2 = toV2Format(PASSWORD);
    const [algo, version, n, r, p, canonicalSalt, canonicalKey] = v2.split('$');
    const v2With = (salt: string, k: string) =>
      `${algo}$${version}$${n}$${r}$${p}$${salt}$${k}`;

    for (const [hash, label] of [
      [v2With(`${canonicalSalt}=`, canonicalKey), 'v2 padded salt'],
      [v2With(canonicalSalt, `${canonicalKey}==`), 'v2 padded key'],
      [v2With(trailingBitAlias(canonicalSalt), canonicalKey), 'v2 trailing-bit alias salt'],
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

describe('legacy login regression (no opportunistic rehash)', () => {
  it('authenticates a legacy credential and leaves the hash byte-identical', async () => {
    const legacyHash = toLegacyFormat(await hashPassword(PASSWORD));
    const { repository, service } = buildLegacyUser(legacyHash);

    const result = await service.login('legacy@example.com', PASSWORD);

    expect(result.user.email).toBe('legacy@example.com');
    expect(typeof result.rawToken).toBe('string');
    expect(repository.sessions).toHaveLength(1);
    expect(repository.users[0]?.passwordHash).toBe(legacyHash);
  });

  it('rejects a wrong password against a legacy credential', async () => {
    const legacyHash = toLegacyFormat(await hashPassword(PASSWORD));
    const { repository, service } = buildLegacyUser(legacyHash);

    await expect(service.login('legacy@example.com', 'Wrong-Password-2026!')).rejects.toThrow();
    expect(repository.sessions).toHaveLength(0);
    expect(repository.users[0]?.passwordHash).toBe(legacyHash);
  });

  it('authenticates a current v1 credential', async () => {
    const currentHash = await hashPassword(PASSWORD);
    const { service } = buildLegacyUser(currentHash);

    const result = await service.login('legacy@example.com', PASSWORD);

    expect(result.user.email).toBe('legacy@example.com');
    expect(typeof result.rawToken).toBe('string');
  });
});
