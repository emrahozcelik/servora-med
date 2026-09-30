import { describe, expect, it } from 'vitest';

import {
  formatTrPhone, isTrPhoneMaskComplete, TR_PHONE_MASK_LENGTH, trPhoneCaret, trPhoneDigits,
  trPhoneEdit, trPhoneInitial, trPhoneMask,
} from '../src/ui/phone';

describe('trPhoneDigits', () => {
  it('reduces every accepted paste shape to the same 0 + 10-digit buffer', () => {
    const expected = '05321234567';
    for (const input of ['05321234567', '(0532) 123 45 67', '0532 123 45 67',
      '+905321234567', '905321234567', '5321234567', '+90 (532) 123-45-67']) {
      expect(trPhoneDigits(input), input).toBe(expected);
    }
  });

  it('keeps over-long input intact so it cannot be silently truncated', () => {
    expect(trPhoneDigits('053212345678')).toBe('053212345678');
    expect(isTrPhoneMaskComplete('053212345678')).toBe(false);
  });

  it('drops the 90 country code only for an exact 12-digit run', () => {
    expect(trPhoneDigits('+905321234567')).toBe('05321234567');
    expect(trPhoneDigits('905321234567')).toBe('05321234567');
    // Malformed: 90 followed by a trunk 0 and 10 more digits. Dropping the `90`
    // would silently repair it into a valid number.
    expect(trPhoneDigits('+9005321234567')).toBe('9005321234567');
    expect(trPhoneDigits('9005321234567')).toBe('9005321234567');
  });

  it('never presents a malformed +90 paste as a complete national number', () => {
    expect(isTrPhoneMaskComplete('+9005321234567')).toBe(false);
    // The `+` survives so the value stays visibly a country-code claim; dropping
    // it would leave `9005321234567`, which no longer reads as one.
    expect(trPhoneMask('+9005321234567')).toBe('+9005321234567');
    expect(isTrPhoneMaskComplete('+90 0532 123 45 67')).toBe(false);
  });
});

describe('trPhoneMask', () => {
  it('builds the (0XXX) XXX XX XX format progressively', () => {
    expect(trPhoneMask('')).toBe('');
    expect(trPhoneMask('0')).toBe('(0');
    expect(trPhoneMask('053')).toBe('(053');
    expect(trPhoneMask('0532')).toBe('(0532)');
    expect(trPhoneMask('0532123')).toBe('(0532) 123');
    expect(trPhoneMask('05321234')).toBe('(0532) 123 4');
    expect(trPhoneMask('0532123456')).toBe('(0532) 123 45 6');
    expect(trPhoneMask('05321234567')).toBe('(0532) 123 45 67');
  });

  it('accepts landline area codes', () => {
    expect(trPhoneMask('03121234567')).toBe('(0312) 123 45 67');
    expect(trPhoneMask('02121234567')).toBe('(0212) 123 45 67');
    expect(trPhoneMask('02161234567')).toBe('(0216) 123 45 67');
  });

  it('is idempotent, so re-masking an already masked value is stable', () => {
    const masked = trPhoneMask('05321234567');
    expect(trPhoneMask(masked)).toBe(masked);
    expect(isTrPhoneMaskComplete(masked)).toBe(true);
  });

  it('shows over-long digits unmasked instead of dropping them', () => {
    expect(trPhoneMask('053212345678')).toBe('053212345678');
  });
});

describe('formatTrPhone', () => {
  it('renders a canonical stored value as the user-facing format', () => {
    expect(formatTrPhone('+905321234567')).toBe('(0532) 123 45 67');
    expect(formatTrPhone('+903121234567')).toBe('(0312) 123 45 67');
    expect(formatTrPhone(null)).toBe('');
    expect(formatTrPhone(undefined)).toBe('');
    expect(formatTrPhone('')).toBe('');
  });

  it('leaves non-canonical historical values exactly as stored', () => {
    expect(formatTrPhone('555')).toBe('555');
    expect(formatTrPhone('  arayın ')).toBe('arayın');
  });
});

describe('trPhoneInitial', () => {
  it('masks canonical and complete values but never rewrites legacy text', () => {
    expect(trPhoneInitial('+905321234567')).toBe('(0532) 123 45 67');
    expect(trPhoneInitial('0532 123 45 67')).toBe('(0532) 123 45 67');
    expect(trPhoneInitial('555')).toBe('555');
    expect(trPhoneInitial('0532123456')).toBe('0532123456');
    expect(trPhoneInitial(null)).toBe('');
  });
});

describe('trPhoneCaret', () => {
  it('places the caret after the requested digit', () => {
    expect(trPhoneCaret('(0532) 123 45 67', 0)).toBe(0);
    expect(trPhoneCaret('(0532) 123 45 67', 4)).toBe(5);
    expect(trPhoneCaret('(0532) 123 45 67', 5)).toBe(8);
    expect(trPhoneCaret('(0532) 123 45 67', 11)).toBe(16);
    expect(trPhoneCaret('(0532) 123 45 67', 99)).toBe(16);
  });
});

describe('trPhoneEdit', () => {
  const masked = '(0532) 123 45 67';

  it('re-masks and keeps the caret on the same digit when only a separator is deleted', () => {
    // Deleting the space after `)` leaves the masked text identical to before, so a
    // value-dependent React effect would never run: the raw text would stay on
    // screen and the caret would be left wherever the browser put it.
    const raw = `${masked.slice(0, 6)}${masked.slice(7)}`;
    expect(raw).toBe('(0532)123 45 67');
    expect(trPhoneEdit(raw, 6)).toEqual({ value: masked, caret: 5 });
  });

  it('re-masks when the second grouping space is deleted', () => {
    const raw = `${masked.slice(0, 10)}${masked.slice(11)}`;
    expect(raw).toBe('(0532) 12345 67');
    expect(trPhoneEdit(raw, 10)).toEqual({ value: masked, caret: 10 });
  });

  it('re-masks when the closing parenthesis is deleted', () => {
    const raw = `${masked.slice(0, 5)}${masked.slice(6)}`;
    expect(raw).toBe('(0532 123 45 67');
    expect(trPhoneEdit(raw, 5)).toEqual({ value: masked, caret: 5 });
  });

  it('keeps the caret after a digit inserted in the middle', () => {
    const start = '(0532) 123 45 6';
    const raw = `${start.slice(0, 6)}7${start.slice(6)}`;
    expect(raw).toBe('(0532)7 123 45 6');
    expect(trPhoneEdit(raw, 7)).toEqual({ value: '(0532) 712 34 56', caret: 8 });
  });

  it('is idempotent for an already masked value with the caret at the end', () => {
    expect(trPhoneEdit(masked, masked.length)).toEqual({ value: masked, caret: masked.length });
  });

  it('leaves a malformed +90 paste over-long instead of repairing it', () => {
    const raw = '+90 0532 123 45 67';
    const result = trPhoneEdit(raw, raw.length);
    expect(result.value).toBe('+9005321234567');
    expect(isTrPhoneMaskComplete(result.value)).toBe(false);
  });

  it('keeps a foreign paste foreign and leaves it incomplete', () => {
    for (const raw of ['+15551234567', '+3572212345']) {
      const result = trPhoneEdit(raw, raw.length);
      expect(result.value, raw).toBe(raw);
      expect(isTrPhoneMaskComplete(result.value), raw).toBe(false);
    }
  });
});

describe('explicit foreign country codes', () => {
  // `+` is a country-code claim. Only `+90` followed by exactly 10 national
  // digits is Turkish; every other `+` value must stay visibly foreign and
  // incomplete, however many digits it happens to carry.
  const foreign: [string, string][] = [
    ['+15551234567', '+15551234567'],
    ['+1 202 555 0147', '+12025550147'],
    ['+3572212345', '+3572212345'],
    ['+495551234567', '+495551234567'],
    ['+9005321234567', '+9005321234567'],
    ['+9003121234567', '+9003121234567'],
    // `+0` + 11 digits: an 11-digit run that a length-only check would call
    // complete even though its first digit is not the Turkish trunk.
    ['+05321234567', '+05321234567'],
  ];

  it('keeps the prefix, adds no trunk 0 and drops no digit', () => {
    for (const [input, shown] of foreign) {
      expect(isTrPhoneMaskComplete(input), input).toBe(false);
      expect(trPhoneMask(input), input).toBe(shown);
      expect(trPhoneDigits(input), input).toBe(shown.slice(1));
    }
  });

  it('does not let an 11-digit foreign run satisfy the structural invariant', () => {
    // `15551234567` and `12025550147` are both exactly 11 digits long, which is
    // why completeness cannot be a digit count: the first digit has to be the
    // trunk `0`, and the input must not be an explicit foreign claim.
    expect(trPhoneDigits('+15551234567')).toHaveLength(TR_PHONE_MASK_LENGTH);
    expect(isTrPhoneMaskComplete('+15551234567')).toBe(false);
    expect(isTrPhoneMaskComplete('15551234567')).toBe(false);
    expect(trPhoneMask('15551234567')).toBe('15551234567');
    expect(trPhoneMask('05321234567')).toBe('(0532) 123 45 67');
  });

  it('keeps the three accepted +90 shapes working', () => {
    const accepted: [string, string][] = [
      ['+905321234567', '(0532) 123 45 67'],
      ['+903121234567', '(0312) 123 45 67'],
      ['+908501234567', '(0850) 123 45 67'],
    ];
    for (const [input, masked] of accepted) {
      expect(isTrPhoneMaskComplete(input), input).toBe(true);
      expect(trPhoneMask(input), input).toBe(masked);
    }
  });

  it('keeps bare Turkish shorthand working', () => {
    expect(trPhoneMask('5321234567')).toBe('(0532) 123 45 67');
    expect(trPhoneMask('905321234567')).toBe('(0532) 123 45 67');
    for (const input of ['5321234567', '05321234567', '905321234567']) {
      expect(isTrPhoneMaskComplete(input), input).toBe(true);
    }
  });
});
