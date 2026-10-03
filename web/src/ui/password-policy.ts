/**
 * Client-side mirror of the server new-password policy. The server remains
 * authoritative: this helper exists only for fast user feedback before submit.
 *
 * Policy: 6–128 characters with at least one Unicode uppercase letter, one
 * ASCII digit, and one symbol (non-letter, non-number, non-whitespace, so
 * whitespace never satisfies the symbol requirement). Lowercase not required.
 */
export const NEW_PASSWORD_MIN_LENGTH = 6;
export const NEW_PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_POLICY_HINT_TR = '6–128 karakter; en az bir büyük harf, bir rakam ve bir sembol.';

export type NewPasswordPolicyIssue =
  | 'too-short'
  | 'too-long'
  | 'missing-uppercase'
  | 'missing-digit'
  | 'missing-symbol';

export function validateNewPasswordPolicy(password: string): NewPasswordPolicyIssue | null {
  if (password.length < NEW_PASSWORD_MIN_LENGTH) return 'too-short';
  if (password.length > NEW_PASSWORD_MAX_LENGTH) return 'too-long';
  if (!/\p{Lu}/u.test(password)) return 'missing-uppercase';
  if (!/[0-9]/.test(password)) return 'missing-digit';
  if (!/[^\p{L}\p{N}\s]/u.test(password)) return 'missing-symbol';
  return null;
}

export function newPasswordPolicyMessage(issue: NewPasswordPolicyIssue): string {
  switch (issue) {
    case 'too-short':
    case 'too-long':
      return 'Yeni parola 6 ile 128 karakter arasında olmalıdır.';
    case 'missing-uppercase':
      return 'Yeni parola en az bir büyük harf içermelidir.';
    case 'missing-digit':
      return 'Yeni parola en az bir rakam içermelidir.';
    case 'missing-symbol':
      return 'Yeni parola en az bir sembol içermelidir (boşluk sembol sayılmaz).';
  }
}
