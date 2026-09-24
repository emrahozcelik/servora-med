import { describe, expect, it } from 'vitest';

import { AppError } from '../src/errors/index.js';
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
  it('accepts a Monday and derives periodEnd as start + 6 days', () => {
    expect(parsePeriodStart(MONDAY)).toEqual({
      periodStart: '2026-08-03',
      periodEnd: '2026-08-09',
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
  it('accepts zero to five questions', () => {
    expect(validateManagerQuestions([])).toEqual([]);
    const five = Array.from({ length: MAX_MANAGER_QUESTIONS }, (_, index) => ({
      key: `q${index + 1}`,
      prompt: `Soru ${index + 1}?`,
    }));
    expect(validateManagerQuestions(five)).toHaveLength(5);
  });

  it('rejects a sixth question', () => {
    const six = Array.from({ length: 6 }, (_, index) => ({
      key: `q${index + 1}`,
      prompt: `Soru ${index + 1}?`,
    }));
    const error = validationError(() => validateManagerQuestions(six));
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
