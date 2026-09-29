/**
 * Turkish phone *display* mask for customer phone inputs.
 *
 * The server owns what a phone number means: `normalizeTurkishPhone` in
 * `server/src/modules/crm/types.ts` is the single normalization source of
 * truth and it rejects anything that is not 10 national digits. This module
 * only decides what the user sees while typing — the field submits exactly the
 * masked text on screen and the server normalizes it. Nothing here rewrites a
 * value for storage, so there is still exactly one normalizer.
 */

/** Trunk `0` plus the 10 national digits of a Turkish number. */
export const TR_PHONE_MASK_LENGTH = 11;

/**
 * Reduces typed or pasted text to the `0` + 10-digit national buffer. A `+90`
 * or `90` country prefix is dropped and a missing trunk `0` is added, so
 * pasting `+905321234567`, `905321234567` and `5321234567` all land on the same
 * buffer as typing `05321234567`.
 *
 * Counts above the mask length are returned untouched on purpose: an over-long
 * paste stays visible and is rejected by the server instead of being silently
 * truncated into a different, valid-looking number.
 */
export function trPhoneDigits(value: string): string {
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('90') && digits.length > 10) digits = digits.slice(2);
  if (digits && !digits.startsWith('0')) digits = `0${digits}`;
  return digits;
}

/** Progressive `(0XXX) XXX XX XX` mask over the national buffer. */
export function trPhoneMask(value: string): string {
  const digits = trPhoneDigits(value);
  if (!digits) return '';
  if (digits.length > TR_PHONE_MASK_LENGTH) return digits;
  const rest = digits.slice(1);
  let masked = `(0${rest.slice(0, 3)}`;
  if (rest.length >= 3) masked += ')';
  if (rest.length > 3) masked += ` ${rest.slice(3, 6)}`;
  if (rest.length > 6) masked += ` ${rest.slice(6, 8)}`;
  if (rest.length > 8) masked += ` ${rest.slice(8, 10)}`;
  return masked;
}

/** True once the mask holds a full national number, so the inline error can clear. */
export function isTrPhoneMaskComplete(value: string): boolean {
  return trPhoneDigits(value).length === TR_PHONE_MASK_LENGTH;
}

/**
 * Renders a stored customer phone as `(0XXX) XXX XX XX`, e.g.
 * `+905321234567` → `(0532) 123 45 67`. Values that are not canonical are
 * returned trimmed and unchanged so historical free-text rows display exactly
 * as stored instead of being silently rewritten.
 */
export function formatTrPhone(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  const match = /^\+90(\d{10})$/.exec(trimmed);
  if (!match) return trimmed;
  const national = match[1]!;
  return `(0${national.slice(0, 3)}) ${national.slice(3, 6)} ${national.slice(6, 8)} ${national.slice(8, 10)}`;
}

/**
 * Initial field text for a stored value. A complete national number is shown
 * masked; anything else is shown exactly as stored, so opening the edit form on
 * a legacy free-text phone does not rewrite it.
 */
export function trPhoneInitial(value: string | null | undefined): string {
  const formatted = formatTrPhone(value);
  return isTrPhoneMaskComplete(formatted) ? trPhoneMask(formatted) : formatted;
}

/** Caret offset that keeps the caret after the same digit it was after before re-masking. */
export function trPhoneCaret(masked: string, digitsBeforeCaret: number): number {
  if (digitsBeforeCaret <= 0) return 0;
  let seen = 0;
  for (let index = 0; index < masked.length; index += 1) {
    if (/\d/.test(masked[index]!)) {
      seen += 1;
      if (seen === digitsBeforeCaret) return index + 1;
    }
  }
  return masked.length;
}
