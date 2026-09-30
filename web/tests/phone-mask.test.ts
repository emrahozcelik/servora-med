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

describe('unsupported characters are never stripped', () => {
  // The web follows the server's lexical grammar: an optional leading `+` plus
  // digits grouped with whitespace, NBSP, narrow NBSP, parentheses, hyphen or
  // dot. Anything else has to stay invalid, because deleting it would turn a
  // malformed paste into a valid Turkish number.
  const unsupported = ['0532x1234567', '90+5321234567', '05_321234567', '0532/1234567',
    '0532 123 45 67 #'];

  it('keeps the text verbatim and never marks it complete', () => {
    for (const input of unsupported) {
      expect(trPhoneMask(input), input).toBe(input);
      expect(isTrPhoneMaskComplete(input), input).toBe(false);
    }
  });

  it('does not repair a letter or a misplaced + into a valid mask', () => {
    // Broad `\D` stripping used to turn these into `(0532) 123 45 67`.
    expect(trPhoneMask('0532x1234567')).toBe('0532x1234567');
    expect(trPhoneDigits('0532x1234567')).not.toBe('05321234567');
    // A `+` that is not leading is not a country-code claim, so it is not honoured.
    expect(trPhoneMask('90+5321234567')).toBe('90+5321234567');
    expect(isTrPhoneMaskComplete('90+5321234567')).toBe(false);
  });

  it('accepts every grouping character the server allows', () => {
    for (const input of ['(0532) 123 45 67', '0532 123-45-67', '0532.123.45.67',
      '0532 123 45 67', '0532\u00a0123\u202f45-67']) {
      expect(isTrPhoneMaskComplete(input), input).toBe(true);
      expect(trPhoneMask(input), input).toBe('(0532) 123 45 67');
    }
  });

  it('leaves the caret alone while the text stays unsupported', () => {
    expect(trPhoneEdit('0532x1234567', 13)).toEqual({ value: '0532x1234567', caret: 13 });
  });
});

describe('explicit +90 rejects a repeated trunk zero', () => {
  it('rejects +90 followed by a national body starting with 0', () => {
    for (const input of ['+900532123456', '+900312123456', '+900850123456']) {
      expect(isTrPhoneMaskComplete(input), input).toBe(false);
      // The `+` survives so the value stays visibly an unresolved claim, and no
      // `00…` national buffer is ever manufactured.
      expect(trPhoneMask(input), input).toBe(input);
      expect(trPhoneDigits(input), input).toBe(input.slice(1));
    }
  });

  it('never turns a repeated trunk zero into a complete national buffer', () => {
    // `+900532123456` used to resolve to `00532123456`, which satisfied the old
    // "11 digits starting with 0" check and was submitted as a valid number.
    expect(trPhoneDigits('+900532123456')).toBe('900532123456');
    expect(isTrPhoneMaskComplete('+900532123456')).toBe(false);
    // A bare `00…` run is equally not a Turkish number.
    expect(isTrPhoneMaskComplete('00532123456')).toBe(false);
    expect(isTrPhoneMaskComplete('005321234567')).toBe(false);
  });

  it('still accepts the three canonical +90 shapes', () => {
    for (const input of ['+905321234567', '+903121234567', '+908501234567']) {
      expect(isTrPhoneMaskComplete(input), input).toBe(true);
    }
  });
});

describe('formatTrPhone formats only canonical values', () => {
  it('formats the canonical +90 shapes', () => {
    expect(formatTrPhone('+905321234567')).toBe('(0532) 123 45 67');
    expect(formatTrPhone('+903121234567')).toBe('(0312) 123 45 67');
    expect(formatTrPhone('+908501234567')).toBe('(0850) 123 45 67');
  });

  it('returns a historical trunk-zero value unchanged instead of rewriting it', () => {
    expect(formatTrPhone('+900532123456')).toBe('+900532123456');
    expect(formatTrPhone('+900312123456')).toBe('+900312123456');
    expect(formatTrPhone('+900850123456')).toBe('+900850123456');
  });

  it('returns free text and empty values unchanged', () => {
    expect(formatTrPhone('santral 555')).toBe('santral 555');
    expect(formatTrPhone('+495551234567')).toBe('+495551234567');
    expect(formatTrPhone(null)).toBe('');
    expect(formatTrPhone(undefined)).toBe('');
    expect(formatTrPhone('')).toBe('');
  });
});

describe('grammar agreement with the server', () => {
  it('marks every server-accepted spelling complete', () => {
    for (const input of ['05321234567', '5321234567', '905321234567', '+905321234567',
      '03121234567', '+903121234567', '08501234567', '+908501234567']) {
      expect(isTrPhoneMaskComplete(input), input).toBe(true);
    }
  });

  it('marks the rejected spellings incomplete', () => {
    for (const input of ['0532x1234567', '90+5321234567', '05_321234567',
      '+15551234567', '+1 202 555 0147', '+3572212345', '+495551234567',
      '+9005321234567', '+900532123456', '+900312123456', '+900850123456',
      '0532', '0532123456', '053212345678', '0', '']) {
      expect(isTrPhoneMaskComplete(input), input).toBe(false);
    }
  });

  it('submits, for every complete value, text the server accepts unchanged', () => {
    // What the mask puts on screen is exactly what the form submits. For every
    // value the web calls complete, that text must itself be a spelling the
    // server normalizes back to the same 10 national digits — no digit dropped,
    // no trunk `0` invented, no country code reinterpreted.
    for (const input of ['05321234567', '5321234567', '905321234567', '+905321234567',
      '03121234567', '+903121234567', '08501234567', '+908501234567',
      '(0532) 123-45-67', '0532.123.45.67']) {
      const submitted = trPhoneMask(input);
      expect(isTrPhoneMaskComplete(submitted), `${input} -> ${submitted}`).toBe(true);
      const digits = submitted.replace(/\D/g, '');
      expect(digits, input).toHaveLength(TR_PHONE_MASK_LENGTH);
      expect(digits.startsWith('0'), input).toBe(true);
      expect(digits[1], input).not.toBe('0');
    }
  });
});
