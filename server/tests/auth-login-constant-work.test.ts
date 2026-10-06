import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R1 fixed-work login KDF budget (structural, never wall-clock).
 *
 * Every login attempt must perform sequentially exactly:
 *   1 × OLD-cost derivation (N=16384) AND 1 × V2-cost derivation (N=32768)
 * regardless of account existence, credential profile, activity, or password
 * correctness — so no branch can reveal which case applied. R1 is
 * reader-first: V2 is verifiable, V1 remains the sole writer, and login
 * performs NO hash mutation.
 *
 * Seam (deterministic, no timing): a counted wrapper around node:crypto
 * `scrypt` recording (N, salt) per derivation, in call order. The salt
 * proves slot assignment — the stored credential salt for a real
 * verification, the sentinel salt for a dummy — because salts are unique
 * per artifact. Budget assertions use the N counts; assignment assertions
 * use the recorded salts.
 */
const derivations = vi.hoisted(() => ({
  counts: new Map<number, number>(),
  slots: [] as { N: number; saltHex: string }[],
}));

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
      const N = options.N ?? -1;
      derivations.counts.set(N, (derivations.counts.get(N) ?? 0) + 1);
      derivations.slots.push({ N, saltHex: Buffer.from(salt as Uint8Array).toString('hex') });
      return actual.scrypt(password as never, salt as never, keylen as never, options as never, callback as never);
    },
  };
});

import { scryptSync } from 'node:crypto';
import { buildApp } from '../src/app.js';
import {
  hashPassword,
  oldCredentialSentinelHash,
  parsePasswordHash,
  v2CredentialSentinelHash,
} from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import { AuthService } from '../src/modules/auth/service.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';

const PASSWORD = 'Fixed-Work-2026!';

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

const SALT_OLD = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const SALT_V2 = [31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46];
const SALT_OLD_HEX = Buffer.from(SALT_OLD).toString('hex');
const SALT_V2_HEX = Buffer.from(SALT_V2).toString('hex');
const LEGACY = () => buildArtifact(PASSWORD, '', 16384, SALT_OLD);
const V1 = () => buildArtifact(PASSWORD, 'v1', 16384, SALT_OLD);
const V2 = () => buildArtifact(PASSWORD, 'v2', 32768, SALT_V2);

async function sentinelSalts() {
  const old = parsePasswordHash(await oldCredentialSentinelHash());
  const v2 = parsePasswordHash(await v2CredentialSentinelHash());
  expect(old?.profile).toBe('SCRYPT_V1');
  expect(v2?.profile).toBe('SCRYPT_V2');
  return {
    old: old!.salt.toString('hex'),
    v2: v2!.salt.toString('hex'),
  };
}

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

function resetSeams() {
  derivations.counts.clear();
  derivations.slots.length = 0;
}

/** Exactly one OLD slot then one V2 slot, in order, no more, no fewer. */
function expectFixedBudget(oldSaltHex: string, v2SaltHex: string) {
  expect(Object.fromEntries(derivations.counts)).toEqual({ 16384: 1, 32768: 1 });
  expect(derivations.slots).toEqual([
    { N: 16384, saltHex: oldSaltHex },
    { N: 32768, saltHex: v2SaltHex },
  ]);
}

describe('login fixed-work budget', () => {
  const now = new Date('2026-10-01T08:00:00.000Z');
  let repository: MemoryAuthRepository;
  let service: AuthService;
  let sentinels: { old: string; v2: string };

  beforeEach(async () => {
    repository = new MemoryAuthRepository();
    repository.users.push({
      id: 'user-1', organizationId: 'org-1', name: 'Admin User',
      email: 'admin@example.com', passwordHash: V1(),
      role: 'ADMIN', mustChangePassword: false, isActive: true, version: 1,
    });
    service = new AuthService(repository, 28_800, () => now);
    sentinels = await sentinelSalts();
    resetSeams();
  });

  it('unknown email: OLD dummy + V2 dummy, generic reject, no session', async () => {
    await expect(service.login('nobody@example.com', 'wrong-password'))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expectFixedBudget(sentinels.old, sentinels.v2);
    expect(repository.sessions).toHaveLength(0);
  });

  it('malformed stored hash: OLD dummy + V2 dummy, generic reject', async () => {
    repository.users[0]!.passwordHash = 'not-a-password-hash';
    resetSeams();

    await expect(service.login('admin@example.com', PASSWORD))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expectFixedBudget(sentinels.old, sentinels.v2);
    expect(repository.sessions).toHaveLength(0);
  });

  it('inactive LEGACY account: same budget before generic reject', async () => {
    repository.users[0]!.passwordHash = LEGACY();
    repository.users[0]!.isActive = false;
    resetSeams();

    await expect(service.login('admin@example.com', PASSWORD))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expectFixedBudget(SALT_OLD_HEX, sentinels.v2);
    expect(repository.sessions).toHaveLength(0);
  });

  it('inactive V2 account: same budget before generic reject', async () => {
    repository.users[0]!.passwordHash = V2();
    repository.users[0]!.isActive = false;
    resetSeams();

    await expect(service.login('admin@example.com', PASSWORD))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expectFixedBudget(sentinels.old, SALT_V2_HEX);
    expect(repository.sessions).toHaveLength(0);
  });

  it('V1 correct: real OLD + dummy V2, session issued, hash untouched', async () => {
    const before = repository.users[0]!.passwordHash;

    const result = await service.login('admin@example.com', PASSWORD);

    expectFixedBudget(SALT_OLD_HEX, sentinels.v2);
    expect(result.rawToken).toHaveLength(43);
    expect(repository.sessions).toHaveLength(1);
    // R1 performs NO rehash: the stored credential is byte-identical.
    expect(repository.users[0]!.passwordHash).toBe(before);
  });

  it('V1 wrong: real OLD + dummy V2, generic reject, no mutation', async () => {
    const before = repository.users[0]!.passwordHash;

    await expect(service.login('admin@example.com', 'wrong-password'))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expectFixedBudget(SALT_OLD_HEX, sentinels.v2);
    expect(repository.sessions).toHaveLength(0);
    expect(repository.users[0]!.passwordHash).toBe(before);
  });

  it('V2 correct: dummy OLD + real V2, session issued, no downgrade', async () => {
    const v2 = V2();
    repository.users[0]!.passwordHash = v2;
    resetSeams();

    const result = await service.login('admin@example.com', PASSWORD);

    expectFixedBudget(sentinels.old, SALT_V2_HEX);
    expect(result.rawToken).toHaveLength(43);
    expect(repository.sessions).toHaveLength(1);
    expect(repository.users[0]!.passwordHash).toBe(v2);
  });

  it('V2 wrong: dummy OLD + real V2, generic reject', async () => {
    const v2 = V2();
    repository.users[0]!.passwordHash = v2;
    resetSeams();

    await expect(service.login('admin@example.com', 'wrong-password'))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expectFixedBudget(sentinels.old, SALT_V2_HEX);
    expect(repository.sessions).toHaveLength(0);
    expect(repository.users[0]!.passwordHash).toBe(v2);
  });
});

describe('fixed-work sentinels', () => {
  it('OLD sentinel is a genuine v1 artifact, V2 sentinel a genuine v2 artifact', async () => {
    const old = parsePasswordHash(await oldCredentialSentinelHash());
    const v2 = parsePasswordHash(await v2CredentialSentinelHash());

    expect(old?.profile).toBe('SCRYPT_V1');
    expect(old?.salt).toHaveLength(16);
    expect(old?.key).toHaveLength(64);
    expect(v2?.profile).toBe('SCRYPT_V2');
    expect(v2?.salt).toHaveLength(16);
    expect(v2?.key).toHaveLength(64);
    expect(await oldCredentialSentinelHash()).not.toBe(await v2CredentialSentinelHash());
  });

  it('each sentinel is derived once per process, never per request', async () => {
    const [aOld, bOld] = await Promise.all([
      oldCredentialSentinelHash(),
      oldCredentialSentinelHash(),
    ]);
    const [aV2, bV2] = await Promise.all([
      v2CredentialSentinelHash(),
      v2CredentialSentinelHash(),
    ]);

    expect(aOld).toBe(bOld);
    expect(aV2).toBe(bV2);
  });
});

/**
 * Cold-start regression.
 *
 * Both sentinels are memoized, so deriving either lazily on the first login
 * would make that one request pay an extra scrypt derivation while later
 * logins do not — re-creating a timing distinction on the first login after
 * every process start / restart / deploy. `buildApp` warms both sentinels
 * before `listen()`; the counted scrypt seam (not wall-clock) proves it.
 */
const appConfig = {
  nodeEnv: 'test' as const, host: '127.0.0.1', port: 3000,
  databaseUrl: 'postgresql://unused', logLevel: 'silent',
  corsOrigin: 'https://app.example.com', sessionTtlSeconds: 28_800,
  loginRateLimitMax: 50, rateLimitWindowMs: 60_000,
  trustedProxy: 'loopback' as const, healthSchemaVersion: null, releaseSha: 'dev',
  capabilities: {
    overviewDashboard: true,
    calendar: false,
    messaging: false,
    backup: false,
    demoDatasetCreation: false,
  },
  support: {
    displayLabel: 'Operasyon desteği',
    email: 'destek@example.test',
    helpUrl: 'https://help.example.test',
  },
};

describe('sentinel warmup at app construction', () => {
  let repository: MemoryAuthRepository;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let freshHashPassword: typeof hashPassword;
  let freshBuildApp: typeof buildApp;

  beforeEach(async () => {
    // Fresh module state per test: sentinel memoization is process-global, so
    // only a re-imported module can prove buildApp itself performs the two
    // derivations. The node:crypto counting seam survives resetModules.
    vi.resetModules();
    const freshCrypto = await import('../src/modules/auth/crypto.js');
    freshHashPassword = freshCrypto.hashPassword;
    ({ buildApp: freshBuildApp } = await import('../src/app.js'));
    repository = new MemoryAuthRepository();
    repository.users.push({
      id: 'user-1', organizationId: 'org-1', name: 'Admin User',
      email: 'admin@example.com', passwordHash: await freshHashPassword('correct-password'),
      role: 'ADMIN', mustChangePassword: false, isActive: true, version: 1,
    });
    resetSeams();
    app = await freshBuildApp(appConfig, { authRepository: repository });
  });

  afterEach(async () => {
    await app.close();
  });

  it('derives exactly one OLD and one V2 sentinel during buildApp', () => {
    // Seeding ran before the reset; the only derivations since are the two
    // warmed sentinels. No HTTP request exists yet.
    expect(Object.fromEntries(derivations.counts)).toEqual({ 16384: 1, 32768: 1 });
  });

  it('cold-start unknown-email login reuses warmed sentinels and pays the fixed budget', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { origin: appConfig.corsOrigin },
      payload: { email: 'nobody@example.com', password: 'wrong-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    // Two warmed derivations + exactly one fixed-budget login (2 slots).
    expect(derivations.counts.get(16384)).toBe(2);
    expect(derivations.counts.get(32768)).toBe(2);
    expect(derivations.slots).toHaveLength(4);
    expect(repository.sessions).toHaveLength(0);
  });

  it('known user with wrong password pays the same fixed budget', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { origin: appConfig.corsOrigin },
      payload: { email: 'admin@example.com', password: 'wrong-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(derivations.counts.get(16384)).toBe(2);
    expect(derivations.counts.get(32768)).toBe(2);
    expect(repository.sessions).toHaveLength(0);
  });

  it('successful login pays the same fixed budget and issues a session', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { origin: appConfig.corsOrigin },
      payload: { email: 'admin@example.com', password: 'correct-password' },
    });

    expect(response.statusCode).toBe(200);
    expect(derivations.counts.get(16384)).toBe(2);
    expect(derivations.counts.get(32768)).toBe(2);
    expect(repository.sessions).toHaveLength(1);
    expect(response.headers['set-cookie']).toMatch(/servora_session=/);
  });
});
