/**
 * Turkish phone *display* mask for customer phone inputs.
 *
 * The server owns what a phone number means: `normalizeTurkishPhone` in
 * `server/src/modules/crm/types.ts` is the single normalization source of
 * truth. This module only decides what the user sees while typing — the field
 * submits exactly the text on screen and the server normalizes it. Nothing here
 * rewrites a value for storage, so there is still exactly one normalizer.
 *
 * The lexical policy is the server's, character for character: an optional
 * leading `+` followed by digits grouped with whitespace, NBSP, narrow NBSP,
 * parentheses, hyphen or dot. Anything else keeps the input invalid instead of
 * being stripped away, so the web can never manufacture a valid Turkish number
 * out of malformed text.
 */

/** Trunk `0` plus the 10 national digits of a Turkish number. */
export const TR_PHONE_MASK_LENGTH = 11;

/**
 * Grouping characters the server grammar allows between digits. Mirrors
 * `TR_PHONE_SEPARATORS` in `server/src/modules/crm/types.ts`; anything outside
 * this set — a letter, an underscore, a misplaced `+` — makes the value invalid
 * rather than being silently dropped.
 */
const TR_PHONE_SEPARATORS = /[\s\u00a0\u202f()\-.]/g;

/**
 * The national-body invariant, shared with the server's `canonicalFromNational`:
 * exactly 10 digits that do not start with the Turkish trunk `0`.
 */
function isCanonicalNational(national: string): boolean {
  return national.length === 10 && !national.startsWith('0');
}

/**
 * The one shape a complete Turkish national buffer can have: exactly 11 digits
 * whose first digit is the trunk `0`, followed by 10 national digits that are
 * not themselves trunk-prefixed.
 *
 * A bare digit count is not enough — `15551234567` is 11 digits too — and
 * `00532123456` is not a Turkish number, because a trunk `0` followed by
 * another `0` is not the national body the server accepts.
 */
function isCompleteTrPhoneBuffer(digits: string): boolean {
  return digits.length === TR_PHONE_MASK_LENGTH && digits.startsWith('0') && digits[1] !== '0';
}

/**
 * True while a bare digit run can still become the `90` country-code form:
 * `9`, `90`, `905`, … up to the 11 digits that precede `90` + 10 national digits.
 *
 * The trunk `0` must not be inserted here. While the run is this short the `90`
 * may still turn out to be the country code, and rewriting `90…` to `(09…` would
 * consume it, so `905321234567` could never be typed from an empty field even
 * though pasting the complete value works. The candidate stays raw until it is
 * long enough to be decided by length alone.
 *
 * A run that is not a prefix of `90` (`95…`, `31…`, `532…`) is not a candidate,
 * so ordinary national shorthand keeps its eager trunk `0`.
 */
function isCountryCodeCandidate(digits: string): boolean {
  if (digits.length <= 2) return digits.length > 0 && '90'.startsWith(digits);
  return digits.startsWith('90') && digits.length <= 12;
}

/**
 * The national body of a stored canonical `+90…` value, or `null` when the
 * value is not canonical under the server invariant. This is what stops a
 * historical `+900532123456` from being rendered as a valid-looking mask.
 */
function canonicalNational(value: string): string | null {
  const match = /^\+90(\d{10})$/.exec(value);
  if (!match) return null;
  const national = match[1]!;
  return isCanonicalNational(national) ? national : null;
}

type TrPhoneBuffer = {
  /** The `0` + 10 national digits buffer, or the raw run when unresolved. */
  digits: string;
  /**
   * True when the text carried an explicit `+` that is not a real `+90` country
   * code (foreign or malformed). Such a value must never be shown as a Turkish
   * national buffer and it can never be complete.
   */
  explicitForeign: boolean;
  /**
   * True when the text contains a character outside the allowed grouping set.
   * The input is then left exactly as typed — no character is dropped — so the
   * value stays invalid instead of being repaired into a Turkish number.
   */
  unsupported: boolean;
};

/**
 * Resolves raw field text to the single buffer every helper works on.
 *
 * The text is read with the server's lexical grammar: an optional leading `+`
 * plus digits grouped with the allowed separators. Anything else
 * (`0532x1234567`, `90+5321234567`, `05_321234567`) marks the value
 * `unsupported` and keeps it verbatim — the letter and the misplaced `+` are
 * never stripped, because stripping them would turn an invalid paste into a
 * valid Turkish number.
 *
 * An explicit `+` is a country-code claim honoured only when exactly 10 national
 * digits follow and the trunk `0` was not repeated, so `+900532123456` is never
 * read as the national buffer `00532123456`. Every other `+` input keeps its
 * prefix and stays unresolved.
 *
 * A bare digit run with no `+` is still read as Turkish: the `90` country code
 * (only when it is followed by exactly 10 national digits) and a missing trunk
 * `0` are resolved, so `905321234567` and `5321234567` land on the same buffer
 * as typing `05321234567`. An incomplete `90…` run is left exactly as typed
 * instead, because it may still grow into that country-code form: the trunk `0`
 * is inserted only once the run can no longer become one. A longer run is
 * returned untouched on purpose: an over-long paste stays visible and is
 * rejected instead of being silently truncated into a different, valid-looking
 * number.
 */
function trPhoneBuffer(value: string): TrPhoneBuffer {
  const trimmed = value.trimStart();
  const explicitCountry = trimmed.startsWith('+');
  const body = explicitCountry ? trimmed.slice(1) : trimmed;
  const digits = body.replace(TR_PHONE_SEPARATORS, '');
  if (!/^\d*$/.test(digits)) return { digits, explicitForeign: false, unsupported: true };
  if (explicitCountry) {
    const national = digits.length === 12 && digits.startsWith('90') ? digits.slice(2) : null;
    return national !== null && isCanonicalNational(national)
      ? { digits: `0${national}`, explicitForeign: false, unsupported: false }
      : { digits, explicitForeign: true, unsupported: false };
  }
  // An incomplete `90…` run is ambiguous, so it is kept exactly as typed: the
  // `90` may still be the country code, and prefixing a trunk `0` now would eat
  // it and make `905321234567` impossible to type. Only a 12-digit run with a
  // canonical national body is decided, and it resolves to the same buffer as
  // typing `05321234567`.
  if (isCountryCodeCandidate(digits)) {
    const national = digits.length === 12 ? digits.slice(2) : null;
    return national !== null && isCanonicalNational(national)
      ? { digits: `0${national}`, explicitForeign: false, unsupported: false }
      : { digits, explicitForeign: false, unsupported: false };
  }
  let national = digits;
  if (national && !national.startsWith('0') && national.length <= 10) national = `0${national}`;
  return { digits: national, explicitForeign: false, unsupported: false };
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
 * which would turn an invalid value into a valid-looking Turkish number.
 *
 * Text with an unsupported character is returned exactly as typed, and a foreign
 * `+` claim keeps its prefix, so both stay visibly invalid and never re-parse as
 * a national buffer.
 */
export function trPhoneMask(value: string): string {
  const { digits, explicitForeign, unsupported } = trPhoneBuffer(value);
  if (unsupported) return value;
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
 * exactly 11 digits, its first digit must be the trunk `0`, the 10 national
 * digits must not be trunk-prefixed, and the text must be neither an explicit
 * foreign `+` claim nor contain an unsupported character. A bare 11-digit
 * foreign run such as `15551234567` therefore stays incomplete even though it
 * has 11 digits.
 */
export function isTrPhoneMaskComplete(value: string): boolean {
  const { digits, explicitForeign, unsupported } = trPhoneBuffer(value);
  return !unsupported && !explicitForeign && isCompleteTrPhoneBuffer(digits);
}

/**
 * Renders a stored customer phone as `(0XXX) XXX XX XX`, e.g.
 * `+905321234567` → `(0532) 123 45 67`.
 *
 * Only a value that satisfies the same canonical invariant as the server is
 * formatted: `+90` plus 10 national digits that do not start with the trunk `0`.
 * Everything else — a historical `+900532123456`, `santral 555`, `+495551234567`
 * — is returned trimmed and unchanged, so an unrelated edit can never silently
 * rewrite a stored value.
 */
export function formatTrPhone(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  const national = canonicalNational(trimmed);
  if (national === null) return trimmed;
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
 * When nothing was rewritten — unsupported text, an unresolved foreign claim, or
 * an already-masked value — the field keeps the caret exactly where the browser
 * put it, so typing an unsupported character does not fling the caret to the end.
 *
 * This is pure and total, so the editing semantics (including deleting a single
 * separator, which leaves the masked text unchanged) can be tested without a
 * DOM and applied deterministically by the input.
 */
export function trPhoneEdit(raw: string, caret: number): { value: string; caret: number } {
  const value = trPhoneMask(raw);
  if (value === raw) return { value, caret: Math.max(0, caret) };
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
