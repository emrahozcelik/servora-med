import { describe, expect, it } from 'vitest';

import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from '../src/modules/auth/crypto.js';

describe('password hashing', () => {
  it('hashes and verifies a valid password with a random salt', async () => {
    const password = 'Correct-Horse-2026';
    const first = await hashPassword(password);
    const second = await hashPassword(password);

    expect(first).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(second).not.toBe(first);
    await expect(verifyPassword(password, first)).resolves.toBe(true);
    await expect(verifyPassword('Wrong-Password-2026', first)).resolves.toBe(false);
  });

  it.each(['short-pass!', 'x'.repeat(129)])('rejects password outside policy bounds', async (password) => {
    await expect(hashPassword(password)).rejects.toThrow(
      'Password must be between 12 and 128 characters',
    );
  });

  it('rejects a malformed stored hash without throwing', async () => {
    await expect(verifyPassword('Correct-Horse-2026', 'not-a-password-hash')).resolves.toBe(false);
  });
});

describe('session token hashing', () => {
  it('creates a high-entropy raw token and stores only its deterministic hash', () => {
    const first = createSessionToken();
    const second = createSessionToken();

    expect(first.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.tokenHash).toBe(hashSessionToken(first.rawToken));
    expect(second.rawToken).not.toBe(first.rawToken);
    expect(second.tokenHash).not.toBe(first.tokenHash);
  });
});
