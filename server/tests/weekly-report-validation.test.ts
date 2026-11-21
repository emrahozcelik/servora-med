import { describe, expect, it } from 'vitest';

import { AppError } from '../src/errors/index.js';
import {
  currentWeeklyReportPeriod,
  weeklyReportDueDate,
} from '../src/modules/weekly-reports/reference.js';
import {
  MAX_MANAGER_QUESTIONS,
  parsePeriodStart,
  validateDraftAnswers,
  validateDraftBody,
  validateManagerQuestions,
  validateSourceWorkSnapshot,
  validateSubmissionAnswers,
  validateSubmissionBody,
} from '../src/modules/weekly-reports/validation.js';
import type { ManagerQuestion } from '../src/modules/weekly-reports/types.js';

function validationError(promise: () => unknown) {
  try {
    promise();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected VALIDATION_ERROR but nothing was thrown');
}

// 2026-08-03 is a Monday; 2026-08-04 is the following Tuesday.
const MONDAY = '2026-08-03';

const QUESTIONS: ManagerQuestion[] = [
  { key: 'q1', prompt: 'Bu hafta hangi müşteride satış fırsatı gördün?' },
  { key: 'q2', prompt: 'En çok hangi ürün soruldu?' },
];

describe('weekly report period validation', () => {
  it('accepts a Monday and derives periodEnd as start + 5 days (Monday–Saturday working week)', () => {
    expect(parsePeriodStart(MONDAY)).toEqual({
      periodStart: '2026-08-03',
      periodEnd: '2026-08-08',
    });
  });

  it('rejects non-Monday dates without guessing timezones', () => {
    const error = validationError(() => parsePeriodStart('2026-08-04'));
    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects malformed dates', () => {
    for (const value of ['not-a-date', '', '2026-13-40', '2026-02-30', '03-08-2026', null, undefined, 20260803]) {
      validationError(() => parsePeriodStart(value));
    }
  });
});

describe('manager question validation', () => {
  it('accepts zero to the technical ceiling of questions', () => {
    expect(validateManagerQuestions([])).toEqual([]);
    const ceiling = Array.from({ length: MAX_MANAGER_QUESTIONS }, (_, index) => ({
      key: `q${index + 1}`,
      prompt: `Soru ${index + 1}?`,
    }));
    expect(validateManagerQuestions(ceiling)).toHaveLength(MAX_MANAGER_QUESTIONS);
  });

  it('accepts more than five questions (the five presets are not the total limit)', () => {
    const eight = Array.from({ length: 8 }, (_, index) => ({
      key: `q${index + 1}`,
      prompt: `Soru ${index + 1}?`,
    }));
    expect(validateManagerQuestions(eight)).toHaveLength(8);
  });

  it('enforces the generous technical ceiling (50), not the historical five', () => {
    expect(MAX_MANAGER_QUESTIONS).toBe(50);
  });

  it('rejects one question past the technical ceiling', () => {
    const over = Array.from({ length: MAX_MANAGER_QUESTIONS + 1 }, (_, index) => ({
      key: `q${index + 1}`,
      prompt: `Soru ${index + 1}?`,
    }));
    const error = validationError(() => validateManagerQuestions(over));
    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects prompts over 500 chars, blank prompts and duplicate keys', () => {
    validationError(() => validateManagerQuestions([{ key: 'q1', prompt: 'x'.repeat(501) }]));
    validationError(() => validateManagerQuestions([{ key: 'q1', prompt: '   ' }]));
    validationError(() => validateManagerQuestions([
      { key: 'q1', prompt: 'Bir?' },
      { key: 'q1', prompt: 'İki?' },
    ]));
    validationError(() => validateManagerQuestions([{ key: 'has space', prompt: 'Soru?' }]));
  });
});

describe('manager answer validation', () => {
  it('allows partial draft answers with known keys', () => {
    expect(validateDraftAnswers(QUESTIONS, [{ questionKey: 'q1', answer: 'Kısmi yanıt.' }]))
      .toEqual([{ questionKey: 'q1', answer: 'Kısmi yanıt.' }]);
  });

  it('rejects unknown keys, duplicates and answers over 4000 chars', () => {
    validationError(() => validateDraftAnswers(QUESTIONS, [{ questionKey: 'q9', answer: 'Yanıt.' }]));
    validationError(() => validateDraftAnswers(QUESTIONS, [
      { questionKey: 'q1', answer: 'Bir.' },
      { questionKey: 'q1', answer: 'İki.' },
    ]));
    validationError(() => validateDraftAnswers(QUESTIONS, [{ questionKey: 'q1', answer: 'x'.repeat(4001) }]));
    validationError(() => validateDraftAnswers(QUESTIONS, [{ questionKey: 'q1', answer: '   ' }]));
  });

  it('requires every question answered at submission', () => {
    const full = [
      { questionKey: 'q1', answer: 'Yanıt bir.' },
      { questionKey: 'q2', answer: 'Yanıt iki.' },
    ];
    expect(validateSubmissionAnswers(QUESTIONS, full)).toEqual(full);
    const error = validationError(() => validateSubmissionAnswers(QUESTIONS, [full[0]]));
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toMatchObject({ missingQuestionKeys: ['q2'] });
  });
});

describe('draft and submission body validation', () => {
  it('accepts an empty draft and normalizes whitespace to null', () => {
    expect(validateDraftBody({})).toEqual({
      summary: null,
      blockers: null,
      nextWeekPlan: null,
      highlights: null,
      fieldObservations: null,
      supportNeeded: null,
    });
    const body = validateDraftBody({ summary: '  Özet.  ', blockers: '   ' });
    expect(body.summary).toBe('Özet.');
    expect(body.blockers).toBeNull();
  });

  it('rejects draft sections over 4000 chars', () => {
    validationError(() => validateDraftBody({ summary: 'x'.repeat(4001) }));
  });

  it('requires summary and next-week plan at submission; blockers stay optional', () => {
    const draft = validateDraftBody({
      summary: 'Özet.',
      nextWeekPlan: 'Plan.',
      highlights: 'Kazanım.',
    });
    expect(validateSubmissionBody(draft)).toEqual({
      summary: 'Özet.',
      blockers: null,
      nextWeekPlan: 'Plan.',
      highlights: 'Kazanım.',
      fieldObservations: null,
      supportNeeded: null,
    });
    validationError(() => validateSubmissionBody(validateDraftBody({ blockers: 'E.', nextWeekPlan: 'P.' })));
    validationError(() => validateSubmissionBody(validateDraftBody({ summary: 'S.', blockers: 'E.' })));
    validationError(() => validateSubmissionBody(validateDraftBody({ summary: 'S.' })));
  });
});

describe('source-work snapshot validation', () => {
  const item = {
    jobCardId: '11111111-1111-4111-8111-111111111111',
    type: 'GENERAL_TASK',
    title: 'Klinik ziyareti',
    customerName: 'Örnek Klinik',
    staffCompletedAt: '2026-08-05T09:00:00.000Z',
    statusAtSnapshot: 'COMPLETED',
  };

  it('accepts a minimal frozen item and an empty list', () => {
    expect(validateSourceWorkSnapshot([])).toEqual([]);
    expect(validateSourceWorkSnapshot([item])).toEqual([item]);
  });

  it('rejects weekly-report self-inclusion and invalid states', () => {
    validationError(() => validateSourceWorkSnapshot([{ ...item, type: 'WEEKLY_REPORT' }]));
    validationError(() => validateSourceWorkSnapshot([{ ...item, statusAtSnapshot: 'IN_PROGRESS' }]));
    validationError(() => validateSourceWorkSnapshot([{ ...item, title: '  ' }]));
    validationError(() => validateSourceWorkSnapshot([{ ...item, staffCompletedAt: 'yesterday' }]));
    validationError(() => validateSourceWorkSnapshot('not-an-array'));
  });
});

describe('weekly report reference and due date (WR-WEEK)', () => {
  it('returns Monday after the working week on weekdays and includes org-local today (A1, A3)', () => {
    // Friday 2026-11-20 10:00 Europe/Istanbul = 07:00Z
    expect(currentWeeklyReportPeriod(new Date('2026-11-20T07:00:00.000Z'), 'Europe/Istanbul')).toEqual({
      timezone: 'Europe/Istanbul',
      today: '2026-11-20',
      periodStart: '2026-11-16',
      periodEnd: '2026-11-21',
      dueDate: '2026-11-23',
    });
    // Monday 2026-11-23 00:30 Europe/Istanbul = 2026-11-22T21:30Z
    expect(currentWeeklyReportPeriod(new Date('2026-11-22T21:30:00.000Z'), 'Europe/Istanbul')).toEqual({
      timezone: 'Europe/Istanbul',
      today: '2026-11-23',
      periodStart: '2026-11-23',
      periodEnd: '2026-11-28',
      dueDate: '2026-11-30',
    });
  });

  it('keeps the just-ended working week on Sunday with Monday due date (A2)', () => {
    // Saturday 2026-11-21 12:00 Europe/Istanbul = 09:00Z
    expect(currentWeeklyReportPeriod(new Date('2026-11-21T09:00:00.000Z'), 'Europe/Istanbul')).toEqual({
      timezone: 'Europe/Istanbul',
      today: '2026-11-21',
      periodStart: '2026-11-16',
      periodEnd: '2026-11-21',
      dueDate: '2026-11-23',
    });
    // Sunday 2026-11-22 12:00 Europe/Istanbul = 09:00Z
    expect(currentWeeklyReportPeriod(new Date('2026-11-22T09:00:00.000Z'), 'Europe/Istanbul')).toEqual({
      timezone: 'Europe/Istanbul',
      today: '2026-11-22',
      periodStart: '2026-11-16',
      periodEnd: '2026-11-21',
      dueDate: '2026-11-23',
    });
  });

  it('derives dueDate as max(periodEnd + 2, requestDateKey) for on-time, late and future weeks (A18, A18b)', () => {
    // Week 2026-11-16..2026-11-21, Monday after = 2026-11-23
    expect(weeklyReportDueDate('2026-11-21', '2026-11-18')).toBe('2026-11-23');
    expect(weeklyReportDueDate('2026-11-21', '2026-11-21')).toBe('2026-11-23');
    expect(weeklyReportDueDate('2026-11-21', '2026-11-23')).toBe('2026-11-23');
    expect(weeklyReportDueDate('2026-11-21', '2026-11-24')).toBe('2026-11-24');
    // Future week 2026-11-23..2026-11-28 requested on 2026-11-18 -> 2026-11-30
    expect(weeklyReportDueDate('2026-11-28', '2026-11-18')).toBe('2026-11-30');
  });
});
