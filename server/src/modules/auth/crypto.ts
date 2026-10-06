import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';

import { AppError } from '../../errors/index.js';

export const NEW_PASSWORD_MIN_LENGTH = 6;
export const NEW_PASSWORD_MAX_LENGTH = 128;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 32 * 1024 * 1024;
/**
 * R2 writer flip: SCRYPT_V2 (N=32768) is now READABLE and WRITABLE. The
 * N=32768 cost was accepted by the bounded cross-environment benchmark
 * (local ARM + GitHub x86, 2 CPU / 4 GiB, run 37492115413, zero
 * errors/timeouts, ~320 MiB peak RSS, stable event loop). R1
 * (`19cfb2ab5511e3ff58a4dad3f64e137e6b05501f`) is the mandatory rollback
 * floor once V2 credentials exist; do not roll back to pre-R1 releases.
 */
const SCRYPT_V2_COST = 32_768;
const SCRYPT_V2_MAX_MEMORY = 64 * 1024 * 1024;

/**
 * Server-side authority for NEW password validation. Applies ONLY when a new
 * password is being set (self-service change, Admin create/reset, bootstrap,
 * dev seed, personnel import). It MUST NOT run against existing credentials:
 * login verification, `verifyPassword`, and the invalid-credential sentinel
 * stay policy-agnostic so historical passwords keep working.
 *
 * Composition (single generic failure, no rule oracle):
 * - length 6..128 inclusive
 * - at least one Unicode uppercase letter (covers Turkish Ş/İ/Ğ/Ü/Ö/Ç)
 * - at least one ASCII digit 0-9
 * - at least one symbol: non-letter, non-number, non-whitespace
 *   (whitespace may exist but never satisfies the symbol requirement)
 * Lowercase is NOT required.
 */
export function validateNewPassword(password: string): void {
  const compliant = password.length >= NEW_PASSWORD_MIN_LENGTH
    && password.length <= NEW_PASSWORD_MAX_LENGTH
    && /\p{Lu}/u.test(password)
    && /[0-9]/.test(password)
    && /[^\p{L}\p{N}\s]/u.test(password);
  if (!compliant) {
    throw new AppError(
      'PASSWORD_POLICY_VIOLATION',
      400,
      'Yeni parola 6–128 karakter olmalı; en az bir büyük harf, bir rakam ve bir sembol içermelidir.',
    );
  }
}

async function derivePasswordKey(
  password: string,
  salt: Buffer,
  cost: number = SCRYPT_COST,
  maxmem: number = SCRYPT_MAX_MEMORY,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: cost,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

/** KDF cost parameters selected ONLY from the parsed profile allowlist. */
function profileKdfParams(profile: PasswordHashProfile): { cost: number; maxmem: number } {
  return profile === 'SCRYPT_V2'
    ? { cost: SCRYPT_V2_COST, maxmem: SCRYPT_V2_MAX_MEMORY }
    : { cost: SCRYPT_COST, maxmem: SCRYPT_MAX_MEMORY };
}

/**
 * Password-hash serialization profiles.
 *
 * Stored-credential grammar (exact):
 *   LEGACY  := "scrypt" "$" N "$" r "$" p "$" saltB64u "$" keyB64u   (6 fields)
 *   V1      := "scrypt" "$" "v1" "$" N "$" r "$" p "$" saltB64u "$" keyB64u
 *   V2      := "scrypt" "$" "v2" "$" N "$" r "$" p "$" saltB64u "$" keyB64u
 * LEGACY/V1 use N=16384; V2 uses N=32768. r=8, p=1, a 16-byte salt and a
 * 64-byte key everywhere, both base64url without padding.
 *
 * R2 writer flip: LEGACY, V1, and V2 artifacts remain verifiable
 * indefinitely, and `hashPassword` emits ONLY V2 (V2_READABLE = YES,
 * V2_WRITABLE = YES). Verification never executes arbitrary stored KDF
 * parameters: each profile allowlists its exact N/r/p, and derivation
 * parameters come only from the parsed profile.
 */
export type PasswordHashProfile = 'LEGACY_SCRYPT' | 'SCRYPT_V1' | 'SCRYPT_V2';

/** Sole writer version (R2). R1's rollback floor already reads it. */
export const CURRENT_PASSWORD_HASH_VERSION = 'v2';

/** Previous writer version; readable indefinitely, no longer emitted. */
export const PREVIOUS_PASSWORD_HASH_VERSION = 'v1';

export interface ParsedPasswordHash {
  profile: PasswordHashProfile;
  salt: Buffer;
  key: Buffer;
}

/**
 * Strict base64url field decoder for stored hash artifacts. Node's base64url
 * decoder is intentionally permissive (padding, standard-Base64 `+`/`/`, and
 * non-canonical trailing-bit aliases can decode to valid bytes), so decoded
 * length alone cannot enforce the documented grammar. This helper requires
 * the exact `A-Za-z0-9-_` alphabet with no padding, the expected byte length,
 * and round-trip canonicality (`decoded.toString('base64url') === input`), so
 * no two accepted textual forms map to the same bytes.
 */
function decodeCanonicalBase64Url(value: string, expectedBytes: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== value) {
    return null;
  }
  return decoded;
}

/**
 * Single SSOT parser for stored password artifacts. Accepts ONLY the three
 * explicitly allowed profiles and rejects everything else (unknown algorithm,
 * unknown version, non-canonical or non-allowlisted N/r/p, bad field count,
 * non-canonical or wrong-length salt/key). Each profile allowlists its exact
 * parameters (LEGACY/V1: N=16384; V2: N=32768); a v2-labeled artifact with any
 * other N is rejected. Verification therefore never executes arbitrary KDF
 * parameters read from the database: a hostile stored artifact cannot request
 * an unbounded scrypt cost.
 *
 * Never throws credential details; returns null for unsupported input.
 */
export function parsePasswordHash(storedHash: string): ParsedPasswordHash | null {
  const parts = storedHash.split('$');
  let profile: PasswordHashProfile;
  let fields: string[];
  if (parts.length === 6) {
    profile = 'LEGACY_SCRYPT';
    fields = parts;
  } else if (parts.length === 7 && parts[1] === CURRENT_PASSWORD_HASH_VERSION) {
    profile = 'SCRYPT_V2';
    fields = [parts[0], ...parts.slice(2)];
  } else if (parts.length === 7 && parts[1] === PREVIOUS_PASSWORD_HASH_VERSION) {
    profile = 'SCRYPT_V1';
    fields = [parts[0], ...parts.slice(2)];
  } else {
    return null;
  }

  const [algorithm, cost, blockSize, parallelization, encodedSalt, encodedKey] = fields;
  const expectedCost = profile === 'SCRYPT_V2' ? SCRYPT_V2_COST : SCRYPT_COST;
  if (
    algorithm !== 'scrypt' ||
    cost !== String(expectedCost) ||
    blockSize !== String(SCRYPT_BLOCK_SIZE) ||
    parallelization !== String(SCRYPT_PARALLELIZATION) ||
    !encodedSalt ||
    !encodedKey
  ) {
    return null;
  }

  const salt = decodeCanonicalBase64Url(encodedSalt, 16);
  const key = decodeCanonicalBase64Url(encodedKey, SCRYPT_KEY_LENGTH);
  if (!salt || !key) {
    return null;
  }
  return { profile, salt, key };
}

/**
 * Pure upgrade classifier (R2). Returns true for supported LEGACY and V1
 * artifacts (both migrate toward V2 after a successful login); V2 artifacts
 * are already final, and malformed/unsupported artifacts are NOT legitimate
 * upgrade candidates. Purely a classification — it mutates nothing and
 * never lets stored artifacts select KDF parameters.
 */
export function passwordHashNeedsUpgrade(storedHash: string): boolean {
  const profile = parsePasswordHash(storedHash)?.profile;
  return profile === 'LEGACY_SCRYPT' || profile === 'SCRYPT_V1';
}

/**
 * Policy-agnostic scrypt KDF. Deliberately performs NO password-policy
 * validation: it must hash legacy credentials, the invalid-credential
 * sentinel source, and internally generated secrets without requiring
 * today's new-password composition. Policy enforcement belongs to the
 * explicit `validateNewPassword` call sites that set new passwords.
 *
 * Emits ONLY the V2 format (R2 writer flip), so newly set passwords and
 * transparent upgrades naturally use the current representation. No call
 * site may construct the format manually.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await derivePasswordKey(
    password,
    salt,
    SCRYPT_V2_COST,
    SCRYPT_V2_MAX_MEMORY,
  );

  return [
    'scrypt',
    CURRENT_PASSWORD_HASH_VERSION,
    SCRYPT_V2_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  try {
    const parsed = parsePasswordHash(storedHash);
    if (!parsed) {
      return false;
    }

    const params = profileKdfParams(parsed.profile);
    const actualKey = await derivePasswordKey(
      password,
      parsed.salt,
      params.cost,
      params.maxmem,
    );
    return timingSafeEqual(actualKey, parsed.key);
  } catch {
    return false;
  }
}

/**
 * Fixed-work login KDF sentinels (one per KDF class).
 *
 * `AuthService.login` must not reveal whether an email exists, whether the
 * account is inactive, or which profile a stored credential uses by skipping
 * KDF work. Every login therefore performs exactly one OLD-cost (N=16384)
 * and one V2-cost (N=32768) derivation, sequentially; paths without a real
 * credential in a slot verify the supplied password against the corresponding
 * process-wide sentinel, so every branch pays the same structural work.
 * This keeps R1 timing-safe as the future R2 rollback target: after R2
 * creates V2 rows, a rollback to R1 still cannot distinguish unknown
 * accounts from V2 accounts by KDF cost.
 *
 * Both sentinels are derived exactly once per process from random,
 * unguessable sources and memoized single-flight. They are never persisted,
 * never belong to a real account, and can never authenticate, because the
 * login path rejects on the missing/inactive user row or a failed match
 * before trusting any verification result. New-password composition policy
 * does not apply to sentinel sources.
 */
let oldSentinelHash: Promise<string> | null = null;
let v2SentinelHash: Promise<string> | null = null;

async function deriveSentinelHash(
  cost: number,
  maxmem: number,
  version: string,
): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await derivePasswordKey(
    randomBytes(32).toString('base64url'),
    salt,
    cost,
    maxmem,
  );
  return ['scrypt', version, cost, SCRYPT_BLOCK_SIZE, SCRYPT_PARALLELIZATION,
    salt.toString('base64url'), derivedKey.toString('base64url')].join('$');
}

/** Memoized single-flight derivation of the OLD-cost (N=16384) sentinel. */
export function oldCredentialSentinelHash(): Promise<string> {
  oldSentinelHash ??= deriveSentinelHash(
    SCRYPT_COST,
    SCRYPT_MAX_MEMORY,
    PREVIOUS_PASSWORD_HASH_VERSION,
  );
  return oldSentinelHash;
}

/** Memoized single-flight derivation of the V2-cost (N=32768) sentinel. */
export function v2CredentialSentinelHash(): Promise<string> {
  v2SentinelHash ??= deriveSentinelHash(
    SCRYPT_V2_COST,
    SCRYPT_V2_MAX_MEMORY,
    CURRENT_PASSWORD_HASH_VERSION,
  );
  return v2SentinelHash;
}

/**
 * Centralized login credential-work abstraction: the single SSOT for login
 * KDF structure. Guarantees the fixed budget structurally — every call
 * performs sequentially exactly one OLD-cost and one V2-cost derivation,
 * never concurrently and with no wall-clock sleep padding.
 *
 * Slot assignment (R2):
 * - OLD stored credential (LEGACY/V1): OLD slot = real verification; V2 slot
 *   = a fresh canonical V2 candidate derived from the SUPPLIED password
 *   (whether verification succeeds or not), returned for transparent-upgrade
 *   reuse only on success — so OLD logins need no third normal-path KDF.
 * - V2 stored credential: OLD slot = dummy verification against the warmed
 *   OLD sentinel; V2 slot = real verification.
 * - Unknown/malformed/unsupported: both slots dummy (OLD + V2 sentinels).
 *
 * Candidate derivation is best-effort maintenance: if it fails at runtime
 * (e.g. memory pressure), the OLD verification result remains authoritative
 * and the login proceeds without an upgrade candidate — a valid OLD password
 * can never produce a 500 or an OLD-credential oracle.
 */
export type LoginCredentialClass = 'OLD' | 'V2' | 'UNSUPPORTED';

export interface LoginPasswordWork {
  credentialClass: LoginCredentialClass;
  matches: boolean;
  /** Exact stored hash that was verified; null unless supported and matching. */
  verifiedHash: string | null;
  /** Precomputed canonical V2 hash; present only when OLD && matches. */
  upgradeCandidateHash?: string;
}

export async function performLoginPasswordWork(
  password: string,
  storedHash: string | null,
): Promise<LoginPasswordWork> {
  const parsed = storedHash ? parsePasswordHash(storedHash) : null;
  if (!parsed) {
    await verifyPassword(password, await oldCredentialSentinelHash());
    await verifyPassword(password, await v2CredentialSentinelHash());
    return { credentialClass: 'UNSUPPORTED', matches: false, verifiedHash: null };
  }
  if (parsed.profile === 'SCRYPT_V2') {
    await verifyPassword(password, await oldCredentialSentinelHash());
    const matches = await verifyPassword(password, storedHash as string);
    return {
      credentialClass: 'V2',
      matches,
      verifiedHash: matches ? (storedHash as string) : null,
    };
  }
  const matches = await verifyPassword(password, storedHash as string);
  // The V2-slot candidate is derived from the SUPPLIED password whether
  // verification succeeds or not (fixed budget) and is returned only on
  // success. Derivation is best-effort: failure must not turn a valid OLD
  // credential into a 500 or create an authentication oracle.
  let upgradeCandidateHash: string | undefined;
  try {
    const candidate = await hashPassword(password);
    if (matches) {
      upgradeCandidateHash = candidate;
    }
  } catch {
    upgradeCandidateHash = undefined;
  }
  return {
    credentialClass: 'OLD',
    matches,
    verifiedHash: matches ? (storedHash as string) : null,
    ...(upgradeCandidateHash ? { upgradeCandidateHash } : {}),
  };
}

export function createSessionToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString('base64url');
  return { rawToken, tokenHash: hashSessionToken(rawToken) };
}

export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
