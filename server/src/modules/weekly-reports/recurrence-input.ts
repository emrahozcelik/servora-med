import { AppError } from '../../errors/index.js';
import { hashRequestIdentity } from '../job-cards/critical-action-request-hash.js';
import {
  optionalBoundedString,
  requireActionId,
  uuidString,
  validation,
} from '../job-cards/validation.js';
import { MAX_REQUEST_INSTRUCTIONS_LENGTH } from './create-input.js';
import { parsePeriodStart } from './validation.js';

/**
 * Recurrence configuration inputs and their normalized request hashes.
 *
 * Every recurrence mutation is an idempotent command: the hash covers the
 * normalized intent only (never `clientActionId`, never a timestamp, never a
 * generated id), so an ambiguous retry with the SAME action id and the SAME
 * intent replays the stored response, while a changed intent under a reused
 * action id is rejected as `CLIENT_ACTION_REUSED`.
 */

export const MAX_RECURRENCE_TARGETS = 50;

const BULK_CREATE_FIELDS = [
  'clientActionId', 'staffUserIds', 'startPeriodStart', 'questions', 'instructions',
] as const;

/**
 * Manager/ADMIN bulk recurrence creation: the same weekly template authorized
 * independently for every selected staff member. Produces N INDEPENDENT rules
 * — there is deliberately no multi-assignee rule.
 */
export type WeeklyReportRecurrenceBulkCreateInput = {
  clientActionId: string;
  /** Canonical lowercase target ids in request order; unique by contract. */
  staffUserIds: string[];
  /** Canonical organization-local Monday; the first period the rule requests. */
  startPeriodStart: string;
  /** Raw question definitions; copied independently into each rule. */
  questions: unknown;
  instructions: string | null;
};

function parseTargetIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw validation('staffUserIds');
  if (value.length > MAX_RECURRENCE_TARGETS) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      `Tek işlemde en fazla ${MAX_RECURRENCE_TARGETS} personel için otomatik rapor kurulabilir.`,
      { fieldErrors: { staffUserIds: `En fazla ${MAX_RECURRENCE_TARGETS} personel.` } },
    );
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const staffUserId = uuidString(entry, 'staffUserIds').toLowerCase();
    if (seen.has(staffUserId)) {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        'Aynı personel bu istekte birden fazla kez yer alamaz.',
        { fieldErrors: { staffUserIds: 'Tekrarlanan personel kimliği.' } },
      );
    }
    seen.add(staffUserId);
    return staffUserId;
  });
}

export function parseWeeklyReportRecurrenceBulkCreateInput(
  value: unknown,
): WeeklyReportRecurrenceBulkCreateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('body');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(BULK_CREATE_FIELDS as readonly string[]).includes(key))) {
    throw validation('body');
  }
  const clientActionId = requireActionId(record.clientActionId);
  const staffUserIds = parseTargetIds(record.staffUserIds);
  if (typeof record.startPeriodStart !== 'string') throw validation('startPeriodStart');
  const { periodStart: startPeriodStart } = parsePeriodStart(record.startPeriodStart);
  const instructions = optionalBoundedString(
    record.instructions, 'instructions', MAX_REQUEST_INSTRUCTIONS_LENGTH,
  );
  return {
    clientActionId,
    staffUserIds,
    startPeriodStart,
    questions: record.questions,
    instructions,
  };
}

const TEMPLATE_UPDATE_FIELDS = ['clientActionId', 'expectedVersion', 'questions', 'instructions'] as const;

/**
 * Future-only template replacement. Both `questions` and `instructions` must
 * be present because the update is a complete replacement, never a sparse
 * merge: an omitted field could silently keep a value the manager meant to
 * clear.
 */
export type WeeklyReportRecurrenceTemplateUpdateInput = {
  clientActionId: string;
  expectedVersion: number;
  questions: unknown;
  instructions: string | null;
};

function expectedVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw validation('expectedVersion');
  return value as number;
}

export function parseWeeklyReportRecurrenceTemplateUpdateInput(
  value: unknown,
): WeeklyReportRecurrenceTemplateUpdateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('body');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(TEMPLATE_UPDATE_FIELDS as readonly string[]).includes(key))) {
    throw validation('body');
  }
  if (!Object.hasOwn(record, 'questions')) throw validation('questions');
  if (!Object.hasOwn(record, 'instructions')) throw validation('instructions');
  return {
    clientActionId: requireActionId(record.clientActionId),
    expectedVersion: expectedVersion(record.expectedVersion),
    questions: record.questions,
    instructions: optionalBoundedString(
      record.instructions, 'instructions', MAX_REQUEST_INSTRUCTIONS_LENGTH,
    ),
  };
}

const PAUSE_FIELDS = ['clientActionId', 'expectedVersion'] as const;

export type WeeklyReportRecurrencePauseInput = {
  clientActionId: string;
  expectedVersion: number;
};

export function parseWeeklyReportRecurrencePauseInput(
  value: unknown,
): WeeklyReportRecurrencePauseInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('body');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(PAUSE_FIELDS as readonly string[]).includes(key))) {
    throw validation('body');
  }
  return {
    clientActionId: requireActionId(record.clientActionId),
    expectedVersion: expectedVersion(record.expectedVersion),
  };
}

const RESUME_FIELDS = ['clientActionId', 'expectedVersion', 'periodStart'] as const;

export type WeeklyReportRecurrenceResumeInput = {
  clientActionId: string;
  expectedVersion: number;
  /** Null = default to the current organization-local week. */
  periodStart: string | null;
};

export function parseWeeklyReportRecurrenceResumeInput(
  value: unknown,
): WeeklyReportRecurrenceResumeInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('body');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(RESUME_FIELDS as readonly string[]).includes(key))) {
    throw validation('body');
  }
  const raw = record.periodStart;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw validation('periodStart');
  return {
    clientActionId: requireActionId(record.clientActionId),
    expectedVersion: expectedVersion(record.expectedVersion),
    periodStart: typeof raw === 'string' ? parsePeriodStart(raw).periodStart : null,
  };
}

/**
 * Normalized bulk-create intent. Target ORDER is not semantic (the same staff
 * set requested in a different order is the same command), so ids are sorted
 * before hashing; `startPeriodStart` and the normalized questions/instructions
 * bind the receipt to the exact template.
 */
export function recurrenceBulkCreateHash(input: {
  staffUserIds: readonly string[];
  startPeriodStart: string;
  questions: unknown;
  instructions: string | null;
}): string {
  return hashRequestIdentity({
    operation: 'WEEKLY_REPORT_RECURRENCE_BULK_CREATE:v1',
    staffUserIds: [...input.staffUserIds].sort(),
    startPeriodStart: input.startPeriodStart,
    questions: input.questions,
    instructions: input.instructions,
  });
}

export function recurrenceTemplateUpdateHash(input: {
  recurrenceId: string;
  questions: unknown;
  instructions: string | null;
}): string {
  return hashRequestIdentity({
    operation: 'WEEKLY_REPORT_RECURRENCE_TEMPLATE_UPDATE:v1',
    recurrenceId: input.recurrenceId,
    questions: input.questions,
    instructions: input.instructions,
  });
}

export function recurrencePauseHash(input: { recurrenceId: string }): string {
  return hashRequestIdentity({
    operation: 'WEEKLY_REPORT_RECURRENCE_PAUSE:v1',
    recurrenceId: input.recurrenceId,
  });
}

export function recurrenceResumeHash(input: {
  recurrenceId: string;
  periodStart: string | null;
}): string {
  return hashRequestIdentity({
    operation: 'WEEKLY_REPORT_RECURRENCE_RESUME:v1',
    recurrenceId: input.recurrenceId,
    periodStart: input.periodStart,
  });
}
