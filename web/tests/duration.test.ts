import { describe, expect, it } from 'vitest';

import {
  formatDurationSeconds,
  formatOverdueLateness,
  formatWaitingMinutes,
  splitMinutes,
  splitSeconds,
} from '../src/ui/duration';

describe('shared duration authority', () => {
  it('splits whole seconds into completed units', () => {
    expect(splitSeconds(42)).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 42 });
    expect(splitSeconds(3_600)).toEqual({ days: 0, hours: 1, minutes: 0, seconds: 0 });
    expect(splitSeconds(86_400)).toEqual({ days: 1, hours: 0, minutes: 0, seconds: 0 });
    expect(splitSeconds(176_400)).toEqual({ days: 2, hours: 1, minutes: 0, seconds: 0 });
    expect(splitSeconds(-5)).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0 });
  });

  it('renders the approved overdue magnitudes with a day tier', () => {
    expect(formatDurationSeconds(42)).toBe('1 dakikadan az');
    expect(formatDurationSeconds(3_540)).toBe('59 dakika');
    expect(formatDurationSeconds(3_600)).toBe('1 saat');
    expect(formatDurationSeconds(11_700)).toBe('3 saat 15 dakika');
    expect(formatDurationSeconds(86_400)).toBe('1 gün');
    expect(formatDurationSeconds(176_400)).toBe('2 gün 1 saat');
    expect(formatDurationSeconds(1_119_600)).toBe('12 gün 23 saat');
  });

  it('omits zero lower units instead of printing them', () => {
    expect(formatDurationSeconds(7_200)).toBe('2 saat');
    expect(formatDurationSeconds(259_200)).toBe('3 gün');
    expect(formatDurationSeconds(273_600)).toBe('3 gün 4 saat');
  });

  it('appends the single shared lateness verb', () => {
    expect(formatOverdueLateness(11_700)).toBe('3 saat 15 dakika gecikti');
    expect(formatOverdueLateness(273_600)).toBe('3 gün 4 saat gecikti');
    expect(formatOverdueLateness(2_520)).toBe('42 dakika gecikti');
  });

  it('keeps the approval-queue wording unchanged, with no day tier', () => {
    expect(splitMinutes(1_500)).toEqual({ hours: 25, minutes: 0 });
    expect(formatWaitingMinutes(1_500)).toBe('25 saat');
    expect(formatWaitingMinutes(90)).toBe('1 saat 30 dakika');
    expect(formatWaitingMinutes(45)).toBe('45 dakika');
    expect(formatWaitingMinutes(120)).toBe('2 saat');
    expect(formatWaitingMinutes(0)).toBe('0 dakika');
  });
});
