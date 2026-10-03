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

async function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

/**
 * Password-hash serialization profiles.
 *
 * Stored-credential grammar (exact):
 *   LEGACY  := "scrypt" "$" N "$" r "$" p "$" saltB64u "$" keyB64u   (6 fields)
 *   CURRENT := "scrypt" "$" "v1" "$" N "$" r "$" p "$" saltB64u "$" keyB64u (7 fields)
 * with N=16384, r=8, p=1, a 16-byte salt and a 64-byte key, both base64url
 * without padding.
 *
 * LEGACY artifacts are production credentials and MUST remain verifiable.
 * CURRENT (SCRYPT_V1) is the only format `hashPassword` emits. Both profiles
 * deliberately share identical KDF parameters in this slice, so invalid
 * credential work stays one equivalent scrypt derivation (Security Slice 1).
 * Profile-cost migration is a separate slice.
 */
export type PasswordHashProfile = 'LEGACY_SCRYPT' | 'SCRYPT_V1';

export const CURRENT_PASSWORD_HASH_VERSION = 'v1';

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
 * Single SSOT parser for stored password artifacts. Accepts ONLY the two
 * explicitly allowed profiles and rejects everything else (unknown algorithm,
 * unknown version, non-canonical or non-allowlisted N/r/p, bad field count,
 * non-canonical or wrong-length salt/key). Verification therefore never
 * executes arbitrary KDF parameters read from the database: a hostile stored
 * artifact cannot request an unbounded scrypt cost.
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
    profile = 'SCRYPT_V1';
    fields = [parts[0], ...parts.slice(2)];
  } else {
    return null;
  }

  const [algorithm, cost, blockSize, parallelization, encodedSalt, encodedKey] = fields;
  if (
    algorithm !== 'scrypt' ||
    cost !== String(SCRYPT_COST) ||
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
 * Pure upgrade classifier: groundwork for a later migration slice. Returns
 * true only for a supported LEGACY artifact; CURRENT artifacts are already
 * final, and malformed/unsupported artifacts are NOT legitimate upgrade
 * candidates. The login path MUST NOT act on this result yet (no
 * opportunistic rehash in this slice).
 */
export function passwordHashNeedsUpgrade(storedHash: string): boolean {
  return parsePasswordHash(storedHash)?.profile === 'LEGACY_SCRYPT';
}

/**
 * Policy-agnostic scrypt KDF. Deliberately performs NO password-policy
 * validation: it must hash legacy credentials, the invalid-credential
 * sentinel source, and internally generated secrets without requiring
 * today's new-password composition. Policy enforcement belongs to the
 * explicit `validateNewPassword` call sites that set new passwords.
 *
 * Emits ONLY the CURRENT versioned format, so newly set passwords naturally
 * use the versioned representation. No call site may construct the format
 * manually. KDF parameters are unchanged from the legacy profile.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await derivePasswordKey(password, salt);

  return [
    'scrypt',
    CURRENT_PASSWORD_HASH_VERSION,
    SCRYPT_COST,
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

    const actualKey = await derivePasswordKey(password, parsed.salt);
    return timingSafeEqual(actualKey, parsed.key);
  } catch {
    return false;
  }
}

/**
 * Constant-work invalid-credential sentinel.
 *
 * `AuthService.login` must not reveal whether an email exists by skipping
 * password KDF work: rejecting an unknown account without deriving a key would
 * make "no such user" measurably cheaper than "known user, wrong password".
 * When no stored hash is available the caller verifies the supplied password
 * against this single process-wide sentinel instead, so every invalid branch
 * pays exactly one scrypt derivation.
 *
 * The sentinel is derived exactly once per process from a random, unguessable
 * source and memoized. It is never persisted, never belongs to a real account,
 * and its only purpose is to consume equivalent work — it can never
 * authenticate, because the login path rejects on the missing user row before
 * trusting the verification result.
 */
let sentinelPasswordHash: Promise<string> | null = null;

/** Memoized single-flight derivation of the invalid-credential sentinel hash. */
export function invalidCredentialSentinelHash(): Promise<string> {
  sentinelPasswordHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return sentinelPasswordHash;
}

export function createSessionToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString('base64url');
  return { rawToken, tokenHash: hashSessionToken(rawToken) };
}

export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
