import { describe, expect, it } from 'vitest';

import {
  formatTrPhone, isTrPhoneMaskComplete, trPhoneCaret, trPhoneDigits, trPhoneInitial, trPhoneMask,
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
