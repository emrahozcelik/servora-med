import { AppError } from '../../errors/index.js';
import {
  addCalendarDaysToDateKey,
  weekdayOfDateKey,
} from '../job-cards/local-calendar.js';
import { JOB_CARD_TYPES } from '../job-cards/types.js';
import {
  codePointLength,
  isoDate,
  optionalBoundedString,
} from '../job-cards/validation.js';
import type {
  ManagerAnswer,
  ManagerQuestion,
  SourceWorkSnapshotItem,
  WeeklyReportDraftBody,
  WeeklyReportPeriod,
  WeeklyReportSubmittedBody,
} from './types.js';

export const MAX_MANAGER_QUESTIONS = 5;
export const MAX_QUESTION_PROMPT_LENGTH = 500;
export const MAX_REPORT_TEXT_LENGTH = 4000;

function validation(field: string) {
  const message = `${field} geçersizdir.`;
  return new AppError('VALIDATION_ERROR', 400, message, {
    fieldErrors: { [field]: message },
  });
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Canonical Weekly Report period parser (single SSOT for Monday arithmetic).
 *
 * Input is a local `YYYY-MM-DD`; output derives `periodEnd = start + 6 days`
 * with calendar-day arithmetic from `local-calendar.ts` (DST-independent).
 * Never guesses timezones from `new Date('YYYY-MM-DD')`.
 */
export function parsePeriodStart(value: unknown): WeeklyReportPeriod {
  if (typeof value !== 'string' || !DATE_KEY_PATTERN.test(value)) {
    throw validation('periodStart');
  }
  const periodStart = isoDate(value, 'periodStart');
  // weekdayOfDateKey: 0 = Sunday … 6 = Saturday, so ISO Monday is 1.
  if (weekdayOfDateKey(periodStart) !== 1) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      'Rapor haftası Pazartesi günü başlamalıdır.',
      { fieldErrors: { periodStart: 'Rapor haftası Pazartesi günü başlamalıdır.' } },
    );
  }
  return { periodStart, periodEnd: addCalendarDaysToDateKey(periodStart, 6) };
}

const QUESTION_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Strongly validated manager-question definitions: at most 5, each with a
 * stable unique key and a prompt of 1..500 code points. Deliberately not a
 * generic dynamic-form engine: fixed shape, fixed bounds, no nesting.
 */
export function validateManagerQuestions(value: unknown): ManagerQuestion[] {
  if (!Array.isArray(value)) throw validation('managerQuestions');
  if (value.length > MAX_MANAGER_QUESTIONS) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      `En fazla ${MAX_MANAGER_QUESTIONS} yönetici sorusu eklenebilir.`,
      { fieldErrors: { managerQuestions: `En fazla ${MAX_MANAGER_QUESTIONS} soru.` } },
    );
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw validation('managerQuestions');
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.key !== 'string' || !QUESTION_KEY_PATTERN.test(record.key.trim())) {
      throw validation('managerQuestions.key');
    }
    const key = record.key.trim();
    if (seen.has(key)) throw validation('managerQuestions.key');
    seen.add(key);
    if (typeof record.prompt !== 'string') throw validation('managerQuestions.prompt');
    const prompt = record.prompt.trim();
    const length = codePointLength(prompt);
    if (length < 1 || length > MAX_QUESTION_PROMPT_LENGTH) {
      throw validation('managerQuestions.prompt');
    }
    return { key, prompt };
  });
}

function validateAnswerShape(
  questions: readonly ManagerQuestion[],
  entry: unknown,
): ManagerAnswer {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw validation('managerAnswers');
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.questionKey !== 'string'
    || !questions.some((question) => question.key === record.questionKey)) {
    throw validation('managerAnswers.questionKey');
  }
  if (typeof record.answer !== 'string') throw validation('managerAnswers.answer');
  const answer = record.answer.trim();
  const length = codePointLength(answer);
  if (length < 1 || length > MAX_REPORT_TEXT_LENGTH) {
    throw validation('managerAnswers.answer');
  }
  return { questionKey: record.questionKey, answer };
}

/**
 * Draft answers may be partial (staff still writing), but every supplied
 * answer must reference a known question key exactly once and stay within
 * 1..4000 code points.
 */
export function validateDraftAnswers(
  questions: readonly ManagerQuestion[],
  value: unknown,
): ManagerAnswer[] {
  if (!Array.isArray(value)) throw validation('managerAnswers');
  const seen = new Set<string>();
  return value.map((entry) => {
    const parsed = validateAnswerShape(questions, entry);
    if (seen.has(parsed.questionKey)) throw validation('managerAnswers.questionKey');
    seen.add(parsed.questionKey);
    return parsed;
  });
}

/**
 * Submission answers must cover every manager question exactly once: a
 * present question without an answer fails closed.
 */
export function validateSubmissionAnswers(
  questions: readonly ManagerQuestion[],
  value: unknown,
): ManagerAnswer[] {
  const answers = validateDraftAnswers(questions, value);
  const missing = questions.filter(
    (question) => !answers.some((answer) => answer.questionKey === question.key),
  );
  if (missing.length > 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      'Tüm yönetici soruları yanıtlanmalıdır.',
      {
        fieldErrors: { managerAnswers: 'Tüm yönetici soruları yanıtlanmalıdır.' },
        missingQuestionKeys: missing.map((question) => question.key),
      },
    );
  }
  return answers;
}

const DRAFT_BODY_FIELDS = [
  'summary',
  'blockers',
  'nextWeekPlan',
  'highlights',
  'fieldObservations',
  'supportNeeded',
] as const;

type DraftBodyField = (typeof DRAFT_BODY_FIELDS)[number];

/**
 * Draft body: every section optional while writing, each capped at 4000
 * code points. Whitespace-only normalizes to null (same convention as
 * `optionalBoundedString`).
 */
export function validateDraftBody(value: unknown): WeeklyReportDraftBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validation('draft');
  }
  const record = value as Record<string, unknown>;
  const body = {} as WeeklyReportDraftBody;
  for (const field of DRAFT_BODY_FIELDS) {
    body[field as DraftBodyField] = optionalBoundedString(
      record[field],
      `draft.${field}`,
      MAX_REPORT_TEXT_LENGTH,
    );
  }
  return body;
}

function requiredBodySection(value: string | null, field: string): string {
  if (value === null || value.trim().length === 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      'Raporun zorunlu bölümleri doldurulmalıdır.',
      { fieldErrors: { [field]: 'Bu bölüm zorunludur.' } },
    );
  }
  return value;
}

/**
 * Submission body (V1 Slice 2 form rules): summary and next-week plan are
 * required; blockers and the remaining sections stay optional. A week with
 * no blockers is legitimate. Bounds already enforced by `validateDraftBody`.
 */
export function validateSubmissionBody(draft: WeeklyReportDraftBody): WeeklyReportSubmittedBody {
  return {
    summary: requiredBodySection(draft.summary, 'draft.summary'),
    blockers: draft.blockers,
    nextWeekPlan: requiredBodySection(draft.nextWeekPlan, 'draft.nextWeekPlan'),
    highlights: draft.highlights,
    fieldObservations: draft.fieldObservations,
    supportNeeded: draft.supportNeeded,
  };
}

/**
 * Source-work snapshot shape guard: frozen display values only (no live
 * joins, no secrets, no full JobCard JSON). Status is restricted to the two
 * submittable states of the V1 activity rule.
 */
export function validateSourceWorkSnapshot(value: unknown): SourceWorkSnapshotItem[] {
  if (!Array.isArray(value)) throw validation('sourceWork');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw validation('sourceWork');
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.jobCardId !== 'string' || record.jobCardId.trim().length === 0) {
      throw validation('sourceWork.jobCardId');
    }
    // Snapshot sources are productive work only: unknown literals and the
    // weekly report itself can never appear, even from direct callers.
    if (typeof record.type !== 'string'
      || !(JOB_CARD_TYPES as readonly string[]).includes(record.type)
      || record.type === 'WEEKLY_REPORT') {
      throw validation('sourceWork.type');
    }
    if (typeof record.title !== 'string' || record.title.trim().length === 0) {
      throw validation('sourceWork.title');
    }
    if (record.customerName !== null && record.customerName !== undefined
      && typeof record.customerName !== 'string') {
      throw validation('sourceWork.customerName');
    }
    if (typeof record.staffCompletedAt !== 'string' || Number.isNaN(Date.parse(record.staffCompletedAt))) {
      throw validation('sourceWork.staffCompletedAt');
    }
    if (record.statusAtSnapshot !== 'WAITING_APPROVAL' && record.statusAtSnapshot !== 'COMPLETED') {
      throw validation('sourceWork.statusAtSnapshot');
    }
    return {
      jobCardId: record.jobCardId,
      type: record.type,
      title: record.title,
      customerName: typeof record.customerName === 'string' ? record.customerName : null,
      staffCompletedAt: record.staffCompletedAt,
      statusAtSnapshot: record.statusAtSnapshot,
    } as SourceWorkSnapshotItem;
  });
}
