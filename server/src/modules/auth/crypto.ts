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
 * Policy-agnostic scrypt KDF. Deliberately performs NO password-policy
 * validation: it must hash legacy credentials, the invalid-credential
 * sentinel source, and internally generated secrets without requiring
 * today's new-password composition. Policy enforcement belongs to the
 * explicit `validateNewPassword` call sites that set new passwords.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await derivePasswordKey(password, salt);

  return [
    'scrypt',
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
    const [algorithm, cost, blockSize, parallelization, encodedSalt, encodedKey] =
      storedHash.split('$');

    if (
      algorithm !== 'scrypt' ||
      Number(cost) !== SCRYPT_COST ||
      Number(blockSize) !== SCRYPT_BLOCK_SIZE ||
      Number(parallelization) !== SCRYPT_PARALLELIZATION ||
      !encodedSalt ||
      !encodedKey
    ) {
      return false;
    }

    const salt = Buffer.from(encodedSalt, 'base64url');
    const expectedKey = Buffer.from(encodedKey, 'base64url');
    if (salt.length !== 16 || expectedKey.length !== SCRYPT_KEY_LENGTH) {
      return false;
    }

    const actualKey = await derivePasswordKey(password, salt);
    return timingSafeEqual(actualKey, expectedKey);
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
