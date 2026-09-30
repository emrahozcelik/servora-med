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
 * The one shape a complete Turkish national buffer can have: exactly 11 digits
 * whose first digit is the trunk `0`, leaving the 10 digits of the national
 * number. A bare 11-digit count is not enough — `15551234567` is 11 digits too.
 */
function isCompleteTrPhoneBuffer(digits: string): boolean {
  return digits.length === TR_PHONE_MASK_LENGTH && digits.startsWith('0');
}

type TrPhoneBuffer = {
  /** The `0` + 10 national digits buffer, or the raw digit run when unresolved. */
  digits: string;
  /**
   * True when the input carried an explicit `+` that is not a real `+90`
   * country code. Such a value is a foreign (or malformed) claim: it must never
   * be shown as a Turkish national buffer and it can never be complete.
   */
  explicitForeign: boolean;
};

/**
 * Resolves raw field text to the single buffer every helper works on.
 *
 * A leading `+` is a country-code claim, so it is honoured only when the digits
 * really are `90` followed by exactly 10 national digits. Every other `+` input
 * is returned as the bare digit run with `explicitForeign` set: the prefix is
 * never dropped, a Turkish trunk `0` is never added, the first foreign digit is
 * never discarded, and a malformed `+` paste is never repaired into a
 * valid-looking Turkish number. That is why `+15551234567`, `+1 202 555 0147`,
 * `+3572212345`, `+495551234567` and `+9005321234567` all stay unresolved.
 *
 * A bare digit run with no `+` is still read as Turkish: the `90` country code
 * (only when it is followed by exactly 10 national digits) and a missing trunk
 * `0` are resolved, so `905321234567` and `5321234567` land on the same buffer
 * as typing `05321234567`. A longer run is returned untouched on purpose: an
 * over-long paste stays visible and is rejected instead of being silently
 * truncated into a different, valid-looking number.
 */
function trPhoneBuffer(value: string): TrPhoneBuffer {
  const digits = value.replace(/\D/g, '');
  if (value.trimStart().startsWith('+')) {
    return digits.length === 12 && digits.startsWith('90')
      ? { digits: `0${digits.slice(2)}`, explicitForeign: false }
      : { digits, explicitForeign: true };
  }
  let national = digits;
  if (national.startsWith('90') && national.length === 12) national = national.slice(2);
  if (national && !national.startsWith('0') && national.length <= 10) national = `0${national}`;
  return { digits: national, explicitForeign: false };
}

/** Digits of the resolved buffer, used by the caret logic. */
export function trPhoneDigits(value: string): string {
  return trPhoneBuffer(value).digits;
}

/**
 * Progressive `(0XXX) XXX XX XX` mask.
 *
 * The mask is only applied to a resolved `0`-leading buffer no longer than the
 * mask: there the leading `0` really is the trunk, so the remaining digits are
 * the national number. Anything else is returned verbatim — masking an
 * unresolved run would mean inventing a trunk `0` and dropping a real digit,
 * which would turn an invalid value into a valid-looking Turkish number. A
 * foreign `+` claim keeps its prefix so it stays visibly foreign and never
 * re-parses as a national buffer.
 */
export function trPhoneMask(value: string): string {
  const { digits, explicitForeign } = trPhoneBuffer(value);
  if (explicitForeign) return `+${digits}`;
  if (!digits) return '';
  if (digits.length > TR_PHONE_MASK_LENGTH || !digits.startsWith('0')) return digits;
  const rest = digits.slice(1);
  let masked = `(0${rest.slice(0, 3)}`;
  if (rest.length >= 3) masked += ')';
  if (rest.length > 3) masked += ` ${rest.slice(3, 6)}`;
  if (rest.length > 6) masked += ` ${rest.slice(6, 8)}`;
  if (rest.length > 8) masked += ` ${rest.slice(8, 10)}`;
  return masked;
}

/**
 * True once the field holds a complete Turkish national number.
 *
 * This is the structural invariant, not a digit count: the buffer must be
 * exactly 11 digits, its first digit must be the trunk `0`, and the input must
 * not have been an explicit foreign `+` claim. A bare 11-digit foreign run such
 * as `15551234567` therefore stays incomplete even though it has 11 digits.
 */
export function isTrPhoneMaskComplete(value: string): boolean {
  const { digits, explicitForeign } = trPhoneBuffer(value);
  return !explicitForeign && isCompleteTrPhoneBuffer(digits);
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

/**
 * Applies the mask to a raw field value and computes the caret to restore.
 *
 * `raw` is whatever the browser put in the field after a keystroke, a paste or a
 * deletion, and `caret` is where the caret sat inside it. The result is the text
 * to write back plus the caret offset.
 *
 * This is pure and total, so the editing semantics (including deleting a single
 * separator, which leaves the masked text unchanged) can be tested without a
 * DOM and applied deterministically by the input.
 */
export function trPhoneEdit(raw: string, caret: number): { value: string; caret: number } {
  const value = trPhoneMask(raw);
  const rawDigits = raw.replace(/\D/g, '');
  const digits = trPhoneDigits(raw);
  const digitsBeforeCaret = raw.slice(0, Math.max(0, caret)).replace(/\D/g, '').length;
  // Only a leading trunk `0` insertion (or no digit change at all) keeps the
  // digit positions aligned; a pasted country prefix moves every digit, so the
  // caret goes to the end there instead of pointing at the wrong place.
  const aligned = digits === rawDigits || digits === `0${rawDigits}`;
  return {
    value,
    caret: aligned ? trPhoneCaret(value, digitsBeforeCaret + (digits === rawDigits ? 0 : 1)) : value.length,
  };
}
