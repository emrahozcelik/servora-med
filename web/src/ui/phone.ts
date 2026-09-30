const CUSTOMER_PHONE_USER_DIGITS = 10;

/**
 * Keeps the create field as one automatic trunk `0` plus at most ten digits.
 * Invalid characters and an eleventh user digit leave the last accepted value
 * unchanged instead of being repaired into a different phone number.
 */
export function customerPhoneInputValue(raw: string, previous: string): string {
  if (!/^\d*$/.test(raw)) return previous;
  const userDigits = raw.startsWith('0') ? raw.slice(1) : raw;
  if (userDigits.length > CUSTOMER_PHONE_USER_DIGITS) return previous;
  return `0${userDigits}`;
}

/** Complete create value: the automatic trunk `0` plus ten user digits. */
export function isCustomerPhoneInputComplete(value: string): boolean {
  return /^0[1-9]\d{9}$/.test(value);
}

/**
 * Renders a stored canonical Turkish phone as `(0XXX) XXX XX XX`.
 * Historical or foreign values are returned unchanged.
 */
export function formatTrPhone(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  const match = /^\+90([1-9]\d{9})$/.exec(trimmed);
  if (!match) return trimmed;
  const national = match[1]!;
  return `(0${national.slice(0, 3)}) ${national.slice(3, 6)} ${national.slice(6, 8)} ${national.slice(8, 10)}`;
}
