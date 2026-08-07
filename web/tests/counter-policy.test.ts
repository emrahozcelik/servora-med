import { describe, expect, it } from 'vitest';

import { counterState } from '../src/ui/counter-policy';

describe('progressive character counter policy', () => {
  it('hides the counter above 500 remaining', () => {
    expect(counterState(501)).toBe('hidden');
    expect(counterState(4000)).toBe('hidden');
  });

  it('shows the counter muted at 500 and down to 101', () => {
    expect(counterState(500)).toBe('normal');
    expect(counterState(101)).toBe('normal');
  });

  it('switches to attention at 100 remaining and below', () => {
    expect(counterState(100)).toBe('attention');
    expect(counterState(1)).toBe('attention');
    expect(counterState(0)).toBe('attention');
  });

  it('keeps the counter visible when the hard limit is exceeded', () => {
    expect(counterState(-1)).toBe('attention');
  });
});
