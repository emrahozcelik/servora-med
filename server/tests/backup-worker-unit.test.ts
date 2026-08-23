import { describe, expect, it } from 'vitest';

import {
  classifyScheduledRetention,
  getDueScheduledSlot,
  getNextScheduledSlot,
  resolveLocalDateTime,
} from '../src/modules/backup/scheduler.js';
import {
  BACKUP_RETRY_MAX_ATTEMPTS,
  isRetryableBackupFailure,
  retryDelayMs,
} from '../src/modules/backup/retry.js';

describe('BR5 scheduled retention classification', () => {
  it('gives monthly precedence to a first-of-month Sunday', () => {
    expect(classifyScheduledRetention(new Date('2026-11-01T12:00:00Z'), 'UTC')).toBe('MONTHLY');
  });

  it('resolves DST gaps to the first valid instant and repeated times once', () => {
    const spring = resolveLocalDateTime('2026-03-08', '02:30', 'America/New_York');
    expect(spring.toISOString()).toBe('2026-03-08T07:00:00.000Z');

    const fall = resolveLocalDateTime('2026-11-01', '01:30', 'America/New_York');
    expect(fall.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('offers only the current local-day slot after its configured time', () => {
    expect(getDueScheduledSlot(new Date('2026-08-22T23:00:00Z'), '02:30', 'Europe/Istanbul')).toBeNull();
    expect(getDueScheduledSlot(new Date('2026-08-23T03:00:00Z'), '02:30', 'UTC')).toMatchObject({
      localDate: '2026-08-23',
      slotKey: 'UTC|2026-08-23|02:30',
      retentionClass: 'WEEKLY',
    });
  });

  it('catches up only the current local day and emits one key across DST repeats', () => {
    const lateToday = getDueScheduledSlot(new Date('2026-08-23T23:00:00Z'), '02:30', 'UTC');
    expect(lateToday).toMatchObject({ localDate: '2026-08-23', slotKey: 'UTC|2026-08-23|02:30' });

    expect(getDueScheduledSlot(new Date('2026-08-24T01:00:00Z'), '02:30', 'UTC')).toBeNull();

    const firstFallOccurrence = getDueScheduledSlot(
      new Date('2026-11-01T05:45:00Z'),
      '01:30',
      'America/New_York',
    );
    const repeatedFallOccurrence = getDueScheduledSlot(
      new Date('2026-11-01T06:45:00Z'),
      '01:30',
      'America/New_York',
    );
    expect(firstFallOccurrence).toMatchObject({
      localDate: '2026-11-01',
      slotKey: 'America/New_York|2026-11-01|01:30',
      scheduledFor: new Date('2026-11-01T05:30:00Z'),
    });
    expect(repeatedFallOccurrence).toMatchObject({
      localDate: '2026-11-01',
      slotKey: firstFallOccurrence?.slotKey,
      scheduledFor: firstFallOccurrence?.scheduledFor,
    });
  });

  it('projects the next scheduled instant with the same IANA/DST resolver', () => {
    expect(getNextScheduledSlot(new Date('2026-08-22T05:00:00Z'), '04:05', 'UTC').scheduledFor)
      .toEqual(new Date('2026-08-23T04:05:00.000Z'));
    expect(getNextScheduledSlot(new Date('2026-11-01T05:45:00Z'), '01:30', 'America/New_York').scheduledFor)
      .toEqual(new Date('2026-11-02T06:30:00.000Z'));
  });

  it('centralizes bounded transient failure classes and exponential delay', () => {
    expect(BACKUP_RETRY_MAX_ATTEMPTS).toBe(3);
    expect(isRetryableBackupFailure('PREFLIGHT_DATABASE_UNAVAILABLE')).toBe(true);
    expect(isRetryableBackupFailure('R2_UPLOAD_FAILED')).toBe(true);
    expect(isRetryableBackupFailure('R2_VERIFY_FAILED')).toBe(true);
    expect(isRetryableBackupFailure('REMOTE_CHECKSUM_MISMATCH')).toBe(false);
    expect(isRetryableBackupFailure('R2_OBJECT_TOO_LARGE')).toBe(false);
    expect(retryDelayMs(1)).toBe(1_000);
    expect(retryDelayMs(2)).toBe(2_000);
    expect(retryDelayMs(3)).toBe(4_000);
  });
});
