import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MAX_RECURRENCE_TARGETS,
  parseWeeklyReportRecurrenceBulkCreateInput,
  parseWeeklyReportRecurrencePauseInput,
  parseWeeklyReportRecurrenceResumeInput,
  parseWeeklyReportRecurrenceTemplateUpdateInput,
  recurrenceBulkCreateHash,
  recurrencePauseHash,
  recurrenceResumeHash,
  recurrenceTemplateUpdateHash,
} from '../src/modules/weekly-reports/recurrence-input.js';

const MONDAY = '2026-10-05';
const TUESDAY = '2026-10-06';
const id = () => randomUUID();

describe('recurrence bulk create input', () => {
  it('accepts a canonical Monday start and normalizes target ids', () => {
    const staffUserId = id();
    const parsed = parseWeeklyReportRecurrenceBulkCreateInput({
      clientActionId: id(),
      staffUserIds: [staffUserId.toUpperCase()],
      startPeriodStart: MONDAY,
      questions: [{ key: 'q1', prompt: 'Soru' }],
      instructions: 'Talimat',
    });
    expect(parsed).toMatchObject({
      staffUserIds: [staffUserId], startPeriodStart: MONDAY, instructions: 'Talimat',
    });
  });

  it('rejects a non-Monday start week', () => {
    expect(() => parseWeeklyReportRecurrenceBulkCreateInput({
      clientActionId: id(), staffUserIds: [id()], startPeriodStart: TUESDAY,
    })).toThrowError(/Pazartesi/i);
  });

  it('rejects an empty or oversized target set', () => {
    expect(() => parseWeeklyReportRecurrenceBulkCreateInput({
      clientActionId: id(), staffUserIds: [], startPeriodStart: MONDAY,
    })).toThrowError(/staffUserIds/i);
    expect(() => parseWeeklyReportRecurrenceBulkCreateInput({
      clientActionId: id(),
      staffUserIds: Array.from({ length: MAX_RECURRENCE_TARGETS + 1 }, () => id()),
      startPeriodStart: MONDAY,
    })).toThrowError(/en fazla 50/i);
  });

  it('rejects duplicate target ids instead of silently de-duplicating', () => {
    const staffUserId = id();
    expect(() => parseWeeklyReportRecurrenceBulkCreateInput({
      clientActionId: id(), staffUserIds: [staffUserId, staffUserId], startPeriodStart: MONDAY,
    })).toThrowError(/birden fazla/i);
  });

  it('rejects unknown fields and a missing action id', () => {
    expect(() => parseWeeklyReportRecurrenceBulkCreateInput({
      clientActionId: id(), staffUserIds: [id()], startPeriodStart: MONDAY, dueDate: MONDAY,
    })).toThrowError(/body/i);
    expect(() => parseWeeklyReportRecurrenceBulkCreateInput({
      staffUserIds: [id()], startPeriodStart: MONDAY,
    })).toThrowError(/clientActionId/i);
  });
});

describe('recurrence template update input', () => {
  it('requires the complete replacement (both questions and instructions present)', () => {
    expect(() => parseWeeklyReportRecurrenceTemplateUpdateInput({
      clientActionId: id(), expectedVersion: 1, questions: [],
    })).toThrowError(/instructions/i);
    expect(() => parseWeeklyReportRecurrenceTemplateUpdateInput({
      clientActionId: id(), expectedVersion: 1, instructions: null,
    })).toThrowError(/questions/i);
    expect(parseWeeklyReportRecurrenceTemplateUpdateInput({
      clientActionId: id(), expectedVersion: 2, questions: [], instructions: null,
    })).toMatchObject({ expectedVersion: 2, instructions: null });
  });

  it('rejects a non-positive expected version', () => {
    expect(() => parseWeeklyReportRecurrenceTemplateUpdateInput({
      clientActionId: id(), expectedVersion: 0, questions: [], instructions: null,
    })).toThrowError(/expectedVersion/i);
  });
});

describe('recurrence pause and resume input', () => {
  it('parses pause with an optimistic version', () => {
    expect(parseWeeklyReportRecurrencePauseInput({
      clientActionId: id(), expectedVersion: 3,
    })).toMatchObject({ expectedVersion: 3 });
  });

  it('treats an omitted or null resume week as the server default', () => {
    expect(parseWeeklyReportRecurrenceResumeInput({
      clientActionId: id(), expectedVersion: 1,
    }).periodStart).toBeNull();
    expect(parseWeeklyReportRecurrenceResumeInput({
      clientActionId: id(), expectedVersion: 1, periodStart: null,
    }).periodStart).toBeNull();
  });

  it('accepts a canonical Monday and rejects a non-Monday resume week', () => {
    expect(parseWeeklyReportRecurrenceResumeInput({
      clientActionId: id(), expectedVersion: 1, periodStart: MONDAY,
    }).periodStart).toBe(MONDAY);
    expect(() => parseWeeklyReportRecurrenceResumeInput({
      clientActionId: id(), expectedVersion: 1, periodStart: TUESDAY,
    })).toThrowError(/Pazartesi/i);
  });
});

describe('recurrence request hashes', () => {
  it('is order-insensitive for the target set', () => {
    const a = id();
    const b = id();
    const base = { startPeriodStart: MONDAY, questions: [], instructions: null };
    expect(recurrenceBulkCreateHash({ ...base, staffUserIds: [a, b] }))
      .toBe(recurrenceBulkCreateHash({ ...base, staffUserIds: [b, a] }));
  });

  it('changes when any part of the intent changes', () => {
    const a = id();
    const base = { staffUserIds: [a], startPeriodStart: MONDAY, questions: [], instructions: null };
    expect(recurrenceBulkCreateHash(base))
      .not.toBe(recurrenceBulkCreateHash({ ...base, startPeriodStart: '2026-10-12' }));
    expect(recurrenceBulkCreateHash(base))
      .not.toBe(recurrenceBulkCreateHash({ ...base, instructions: 'X' }));
    expect(recurrenceBulkCreateHash(base))
      .not.toBe(recurrenceBulkCreateHash({
        ...base, questions: [{ key: 'q1', prompt: 'Soru' }],
      }));
  });

  it('binds the template, pause and resume receipts to their rule', () => {
    const rule = id();
    expect(recurrenceTemplateUpdateHash({ recurrenceId: rule, questions: [], instructions: null }))
      .not.toBe(recurrenceTemplateUpdateHash({
        recurrenceId: rule, questions: [], instructions: 'X',
      }));
    expect(recurrencePauseHash({ recurrenceId: rule }))
      .not.toBe(recurrencePauseHash({ recurrenceId: id() }));
    expect(recurrenceResumeHash({ recurrenceId: rule, periodStart: null }))
      .not.toBe(recurrenceResumeHash({ recurrenceId: rule, periodStart: MONDAY }));
  });
});
