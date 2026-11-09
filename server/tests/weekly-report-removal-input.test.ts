import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseWeeklyReportRemovalInput, weeklyReportRemovalRequestHash } from '../src/modules/weekly-reports/removal-input.js';

const input = { clientActionId: randomUUID(), expectedVersion: 4, expectedReportVersion: 2, reason: 'Yanlış hafta.' };

describe('Weekly Report removal intent', () => {
  it('normalizes the reason and counts Unicode code points', () => {
    expect(parseWeeklyReportRemovalInput({ ...input, reason: '  Yanlış hafta.  ' })).toEqual(input);
    expect(parseWeeklyReportRemovalInput({ ...input, reason: '🦷'.repeat(2000) }).reason).toHaveLength(4000);
  });

  it.each([null, [], {}, { ...input, clientActionId: '' }, { ...input, reason: ' \n ' },
    { ...input, reason: 42 }, { ...input, reason: '🦷'.repeat(2001) },
    { ...input, expectedVersion: 0 }, { ...input, expectedVersion: 1.1 },
    { ...input, expectedReportVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...input, expectedReportVersion: '2' }, { ...input, deleteSourceWork: true },
  ])('rejects malformed or overbroad requests: %#', value => {
    expect(() => parseWeeklyReportRemovalInput(value)).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('binds retries to the original target, both versions and normalized reason', () => {
    const target = randomUUID();
    const hash = weeklyReportRemovalRequestHash(target,input);
    expect(weeklyReportRemovalRequestHash(target,{ ...input,clientActionId: randomUUID() })).toBe(hash);
    for (const changed of [{ expectedVersion: 5 }, { expectedReportVersion: 3 }, { reason: 'Başka gerekçe.' }]) {
      expect(weeklyReportRemovalRequestHash(target,{ ...input,...changed })).not.toBe(hash);
    }
    expect(weeklyReportRemovalRequestHash(randomUUID(),input)).not.toBe(hash);
  });
});
