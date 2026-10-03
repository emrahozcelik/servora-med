import { describe, expect, it } from 'vitest';

import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  validateNewPassword,
  verifyPassword,
} from '../src/modules/auth/crypto.js';

describe('password hashing', () => {
  it('hashes and verifies a valid password with a random salt', async () => {
    const password = 'Correct-Horse-2026!';
    const first = await hashPassword(password);
    const second = await hashPassword(password);

    expect(first).toMatch(/^scrypt\$v1\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(second).not.toBe(first);
    await expect(verifyPassword(password, first)).resolves.toBe(true);
    await expect(verifyPassword('Wrong-Password-2026!', first)).resolves.toBe(false);
  });

  it('hashes without enforcing the new-password policy (policy-agnostic KDF)', async () => {
    // Historical credentials, short secrets, and internal KDF artifacts must
    // remain hashable: policy enforcement lives at the set-password surfaces.
    for (const password of ['legacy-password', 'short', 'x'.repeat(129), '  spaces  ']) {
      const hash = await hashPassword(password);
      await expect(verifyPassword(password, hash)).resolves.toBe(true);
    }
  });

  it('rejects a malformed stored hash without throwing', async () => {
    await expect(verifyPassword('Correct-Horse-2026!', 'not-a-password-hash')).resolves.toBe(false);
  });
});

describe('new-password policy', () => {
  it.each(['Serv1!', 'Şifre1!', 'ABC1!D', 'A1!bcd', `A1!${'x'.repeat(125)}`, 'İzmir1!'])(
    'accepts compliant password %s',
    (password) => {
      expect(() => validateNewPassword(password)).not.toThrow();
    },
  );

  it.each([
    ['A1!bc', 'too short'],
    [`A1!${'x'.repeat(126)}`, 'too long'],
    ['serv1!', 'no uppercase'],
    ['Server!', 'no digit'],
    ['Server1', 'no symbol'],
    ['Abc1 2', 'whitespace is not a symbol'],
  ])('rejects non-compliant password (%s: %s)', (password) => {
    try {
      validateNewPassword(password);
      expect.unreachable('expected PASSWORD_POLICY_VIOLATION');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PASSWORD_POLICY_VIOLATION', statusCode: 400 });
    }
  });

  it('does not require lowercase', () => {
    expect(() => validateNewPassword('ABC1!D')).not.toThrow();
  });

  it('accepts Turkish uppercase letters', () => {
    for (const password of ['Şifre1!', 'İzmir1!', 'ĞÜÖÇ1!a']) {
      expect(() => validateNewPassword(password)).not.toThrow();
    }
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
