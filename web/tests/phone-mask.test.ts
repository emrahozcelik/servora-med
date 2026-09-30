import { describe, expect, it } from 'vitest';

import {
  customerPhoneInputValue,
  formatTrPhone,
  isCustomerPhoneInputComplete,
} from '../src/ui/phone';

describe('simple customer phone input', () => {
  it('keeps one automatic trunk zero while the user enters ten digits', () => {
    expect(customerPhoneInputValue('', '0')).toBe('0');
    expect(customerPhoneInputValue('5', '0')).toBe('05');
    expect(customerPhoneInputValue('5321234567', '0')).toBe('05321234567');
    expect(customerPhoneInputValue('05321234567', '0')).toBe('05321234567');
  });

  it('keeps the last accepted value for a non-digit or an eleventh user digit', () => {
    expect(customerPhoneInputValue('0532x', '0532')).toBe('0532');
    expect(customerPhoneInputValue('+905321234567', '0532')).toBe('0532');
    expect(customerPhoneInputValue('053212345678', '05321234567')).toBe('05321234567');
  });

  it('is complete only with the automatic zero and ten user digits', () => {
    expect(isCustomerPhoneInputComplete('05321234567')).toBe(true);
    expect(isCustomerPhoneInputComplete('0532123456')).toBe(false);
    expect(isCustomerPhoneInputComplete('00532123456')).toBe(false);
    expect(isCustomerPhoneInputComplete('5321234567')).toBe(false);
  });
});

describe('formatTrPhone', () => {
  it('formats canonical stored Turkish phones for display', () => {
    expect(formatTrPhone('+905321234567')).toBe('(0532) 123 45 67');
    expect(formatTrPhone('+903121234567')).toBe('(0312) 123 45 67');
  });

  it('preserves empty, historical, malformed, and foreign values', () => {
    expect(formatTrPhone(null)).toBe('');
    expect(formatTrPhone('  santral 555  ')).toBe('santral 555');
    expect(formatTrPhone('+900532123456')).toBe('+900532123456');
    expect(formatTrPhone('+495551234567')).toBe('+495551234567');
  });
});
