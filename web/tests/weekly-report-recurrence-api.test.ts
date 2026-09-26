import { describe, expect, it } from 'vitest';

import {
  MAX_RECURRENCE_TARGETS,
  parseWeeklyReportRecurrenceBulkResult,
  parseWeeklyReportRecurrenceList,
  parseWeeklyReportRecurrencePauseResult,
  parseWeeklyReportRecurrenceResumeResult,
  parseWeeklyReportRecurrenceTemplateResult,
} from '../src/jobs/weekly-report-api';

const rule = {
  id: 'rec-1',
  staffUserId: 'staff-1',
  staffName: 'Ayşe Personel',
  enabled: true,
  disabledReason: null,
  nextPeriodStart: '2026-10-05',
  questions: [{ key: 'q1', prompt: 'Bu hafta ne yaptın?' }],
  instructions: 'Lütfen doldurun.',
  version: 1,
  lastProcessedPeriodStart: '2026-09-28',
  lastOutcome: 'created',
  lastErrorCode: null,
  updatedAt: '2026-09-28T09:00:00.000Z',
};

describe('weekly report recurrence api parsers', () => {
  it('mirrors the server recurrence ceiling for the multi-select guard', () => {
    expect(MAX_RECURRENCE_TARGETS).toBe(50);
  });

  it('parses the recurrence list exactly', () => {
    expect(parseWeeklyReportRecurrenceList({ items: [rule] })).toEqual({ items: [rule] });
    expect(parseWeeklyReportRecurrenceList({ items: [] })).toEqual({ items: [] });
  });

  it('accepts a paused rule with an auto-pause reason and no last outcome yet', () => {
    const paused = {
      ...rule, enabled: false, disabledReason: 'STAFF_INELIGIBLE',
      lastProcessedPeriodStart: null, lastOutcome: null, lastErrorCode: 'STAFF_INELIGIBLE',
    };
    expect(parseWeeklyReportRecurrenceList({ items: [paused] }).items[0]).toEqual(paused);
  });

  it('fails closed on unknown keys, unknown enums and malformed dates', () => {
    expect(() => parseWeeklyReportRecurrenceList({ items: [rule], bogus: 1 })).toThrow();
    expect(() => parseWeeklyReportRecurrenceList({ items: [{ ...rule, extra: true }] })).toThrow();
    expect(() => parseWeeklyReportRecurrenceList({
      items: [{ ...rule, disabledReason: 'BECAUSE' }],
    })).toThrow();
    expect(() => parseWeeklyReportRecurrenceList({
      items: [{ ...rule, lastOutcome: 'maybe' }],
    })).toThrow();
    expect(() => parseWeeklyReportRecurrenceList({
      items: [{ ...rule, nextPeriodStart: 'not-a-date' }],
    })).toThrow();
    expect(() => parseWeeklyReportRecurrenceList({
      items: [{ ...rule, enabled: 'yes' }],
    })).toThrow();
  });

  it('never accepts a lease or retry internal leaked into a rule', () => {
    // Lease/retry state is an operational internal, not a client contract: the
    // exact-key parser must reject any response that carries one.
    for (const leaked of [
      { leaseToken: 'l-1' }, { leaseUntil: '2026-10-05T00:00:00.000Z' },
      { nextAttemptAt: '2026-10-05T00:00:00.000Z' }, { failureCount: 3 },
    ]) {
      expect(() => parseWeeklyReportRecurrenceList({ items: [{ ...rule, ...leaked }] })).toThrow();
    }
  });

  it('parses the bulk create result exactly, including mixed outcomes', () => {
    const bulk = {
      startPeriodStart: '2026-10-05',
      items: [
        { recurrenceId: 'rec-1', staffUserId: 'staff-1', outcome: 'created', enabled: true, nextPeriodStart: '2026-10-05', version: 1 },
        { recurrenceId: 'rec-2', staffUserId: 'staff-2', outcome: 'existing', enabled: false, nextPeriodStart: '2026-10-12', version: 3 },
      ],
    };
    expect(parseWeeklyReportRecurrenceBulkResult(bulk)).toEqual(bulk);
    expect(() => parseWeeklyReportRecurrenceBulkResult({ ...bulk, bogus: 1 })).toThrow();
    expect(() => parseWeeklyReportRecurrenceBulkResult({
      ...bulk, items: [{ ...bulk.items[0], outcome: 'maybe' }],
    })).toThrow();
    expect(() => parseWeeklyReportRecurrenceBulkResult({
      ...bulk, startPeriodStart: 'nope',
    })).toThrow();
  });

  it('parses the template, pause and resume results exactly', () => {
    const template = {
      recurrenceId: 'rec-1', version: 2,
      questions: [{ key: 'q1', prompt: 'Soru?' }], instructions: null,
      nextPeriodStart: '2026-10-05',
    };
    expect(parseWeeklyReportRecurrenceTemplateResult(template)).toEqual(template);
    expect(() => parseWeeklyReportRecurrenceTemplateResult({ ...template, version: 0 })).toThrow();

    const pause = {
      recurrenceId: 'rec-1', enabled: false, disabledReason: 'MANUAL',
      nextPeriodStart: '2026-10-05', version: 2,
    };
    expect(parseWeeklyReportRecurrencePauseResult(pause)).toEqual(pause);
    // A pause response that claims to be enabled is a contract violation.
    expect(() => parseWeeklyReportRecurrencePauseResult({ ...pause, enabled: true })).toThrow();

    const resume = {
      recurrenceId: 'rec-1', enabled: true, nextPeriodStart: '2026-10-26', version: 3,
    };
    expect(parseWeeklyReportRecurrenceResumeResult(resume)).toEqual(resume);
    expect(() => parseWeeklyReportRecurrenceResumeResult({ ...resume, enabled: false })).toThrow();
  });
});
