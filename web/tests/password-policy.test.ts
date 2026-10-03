import { describe, expect, it } from 'vitest';

import {
  NEW_PASSWORD_MAX_LENGTH,
  NEW_PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_HINT_TR,
  newPasswordPolicyMessage,
  validateNewPasswordPolicy,
} from '../src/ui/password-policy';

/** Client-side mirror of the server new-password policy (server authoritative). */
describe('new-password policy helper', () => {
  it('pins the 6..128 bounds', () => {
    expect(NEW_PASSWORD_MIN_LENGTH).toBe(6);
    expect(NEW_PASSWORD_MAX_LENGTH).toBe(128);
  });

  it('states the Turkish composition hint', () => {
    expect(PASSWORD_POLICY_HINT_TR).toBe('6–128 karakter; en az bir büyük harf, bir rakam ve bir sembol.');
  });

  it.each(['Serv1!', 'Şifre1!', 'ABC1!D', 'A1!bcd', `A1!${'x'.repeat(125)}`, 'İzmir1!'])(
    'accepts compliant password %s',
    (password) => {
      expect(validateNewPasswordPolicy(password)).toBeNull();
    },
  );

  it.each([
    ['A1!bc', 'too-short'],
    [`A1!${'x'.repeat(126)}`, 'too-long'],
    ['serv1!', 'missing-uppercase'],
    ['Server!', 'missing-digit'],
    ['Server1', 'missing-symbol'],
    ['Abc1 2', 'missing-symbol'],
  ])('rejects %s with %s', (password, issue) => {
    expect(validateNewPasswordPolicy(password)).toBe(issue);
    expect(newPasswordPolicyMessage(issue as never)).toBeTruthy();
  });

  it('does not require lowercase and accepts Turkish uppercase', () => {
    expect(validateNewPasswordPolicy('ABC1!D')).toBeNull();
    expect(validateNewPasswordPolicy('Şifre1!')).toBeNull();
  });
});
