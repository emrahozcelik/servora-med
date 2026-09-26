import { AppError } from '../../errors/index.js';
import { hashRequestIdentity } from '../job-cards/critical-action-request-hash.js';
import {
  isoDate,
  optionalBoundedString,
  requireActionId,
  uuidString,
  validation,
} from '../job-cards/validation.js';
import { parsePeriodStart } from './validation.js';

export const MAX_REQUEST_INSTRUCTIONS_LENGTH = 2000;

const CREATE_FIELDS = [
  'clientActionId', 'periodStart', 'assignedTo', 'questions', 'instructions',
] as const;

/**
 * Public single-report creation intent. A dedicated command (not generic
 * JobCard create with WeeklyReport-only optionals): the only accepted type
 * is WEEKLY_REPORT and the payload carries exactly the report dimensions.
 */
export type WeeklyReportCreateInput = {
  clientActionId: string;
  /** Canonical Monday; service derives periodEnd +6 and the canonical deadline. */
  periodStart: string;
  periodEnd: string;
  /** Null = self (STAFF path); uuid = single target (MANAGER/ADMIN path). */
  assignedTo: string | null;
  /** Raw question definitions; role rules enforced by the service. */
  questions: unknown;
  /** Optional manager request instructions → JobCard description. */
  instructions: string | null;
};

function optionalAssignedTo(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return uuidString(value, 'assignedTo');
}

export function parseWeeklyReportCreateInput(value: unknown): WeeklyReportCreateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('body');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(CREATE_FIELDS as readonly string[]).includes(key))) {
    throw validation('body');
  }
  const clientActionId = requireActionId(record.clientActionId);
  if (typeof record.periodStart !== 'string') throw validation('periodStart');
  const { periodStart, periodEnd } = parsePeriodStart(record.periodStart);
  const assignedTo = optionalAssignedTo(record.assignedTo);
  const instructions = optionalBoundedString(
    record.instructions, 'instructions', MAX_REQUEST_INSTRUCTIONS_LENGTH,
  );
  return {
    clientActionId,
    periodStart,
    periodEnd,
    assignedTo,
    questions: record.questions,
    instructions,
  };
}

export const MAX_BULK_TARGETS = 50;

const BULK_REQUEST_FIELDS = [
  'clientActionId', 'staffUserIds', 'periodStart', 'questions', 'instructions',
] as const;

/**
 * Manager/ADMIN bulk request intent: the SAME report dimensions applied
 * independently to every selected staff member. It is one logical command
 * that may produce N independent WeeklyReport JobCards — never a shared
 * multi-assignee report, so no shared report-level field exists here.
 */
export type WeeklyReportBulkRequestInput = {
  clientActionId: string;
  /**
   * Canonical lowercase target ids in request order. Unique by contract:
   * repeated ids are rejected as malformed instead of silently de-duplicated,
   * so the caller's intent is never reinterpreted.
   */
  staffUserIds: string[];
  /** Canonical Monday; periodEnd derives +6 and the canonical deadline +1. */
  periodStart: string;
  periodEnd: string;
  /** Raw question definitions; copied independently into each report row. */
  questions: unknown;
  /** Optional manager request instructions → each target JobCard description. */
  instructions: string | null;
};

/**
 * Target ids are lowercased so their text order equals the PostgreSQL `uuid`
 * byte order. `lockUsersInOrder` sorts ids as text before locking, so this
 * normalization is what makes the deterministic lock order match
 * `ORDER BY id` for every possible client encoding of the same uuid.
 */
function parseStaffUserIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw validation('staffUserIds');
  if (value.length > MAX_BULK_TARGETS) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      `Tek işlemde en fazla ${MAX_BULK_TARGETS} personel için rapor istenebilir.`,
      { fieldErrors: { staffUserIds: `En fazla ${MAX_BULK_TARGETS} personel.` } },
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

export function parseWeeklyReportBulkRequestInput(value: unknown): WeeklyReportBulkRequestInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('body');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(BULK_REQUEST_FIELDS as readonly string[]).includes(key))) {
    throw validation('body');
  }
  const clientActionId = requireActionId(record.clientActionId);
  const staffUserIds = parseStaffUserIds(record.staffUserIds);
  if (typeof record.periodStart !== 'string') throw validation('periodStart');
  const { periodStart, periodEnd } = parsePeriodStart(record.periodStart);
  const instructions = optionalBoundedString(
    record.instructions, 'instructions', MAX_REQUEST_INSTRUCTIONS_LENGTH,
  );
  return {
    clientActionId,
    staffUserIds,
    periodStart,
    periodEnd,
    questions: record.questions,
    instructions,
  };
}

/** Deterministic neutral title: ISO dates only, no locale month names. */
export function weeklyReportTitle(periodStart: string, periodEnd: string): string {
  return `Haftalık Rapor (${periodStart} – ${periodEnd})`;
}

const DRAFT_PATCH_FIELDS = ['expectedVersion', 'draft', 'answers'] as const;

export type WeeklyReportDraftPatchInput = {
  expectedVersion: number;
  draft: unknown;
  answers: unknown;
};

/** Complete-replacement draft patch: all sections travel together. */
export function parseWeeklyReportDraftPatch(value: unknown): WeeklyReportDraftPatchInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('body');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(DRAFT_PATCH_FIELDS as readonly string[]).includes(key))) {
    throw validation('body');
  }
  if (!Number.isInteger(record.expectedVersion)
    || (record.expectedVersion as number) < 1) {
    throw validation('expectedVersion');
  }
  return {
    expectedVersion: record.expectedVersion as number,
    draft: record.draft,
    answers: record.answers,
  };
}

export function weeklyReportCreateRequestHash(input: {
  periodStart: string;
  periodEnd: string;
  assignedTo: string | null;
  questions: unknown;
  instructions: string | null;
}): string {
  // Same critical-action hashing contract as generic creates: normalized
  // intent only (clientActionId/requestTime/generated ids never hashed).
  // Callers pass validated canonical questions, never raw input. The deadline
  // is deliberately NOT part of the identity: it is server-canonical
  // (periodEnd + 1) so there is no caller-provided dueDate dimension.
  return hashRequestIdentity({
    operation: 'WEEKLY_REPORT_CREATE:v1',
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    assignedTo: input.assignedTo,
    questions: input.questions,
    instructions: input.instructions,
  });
}

/**
 * Normalized bulk-request intent. Target ORDER is not semantic — the same
 * set of staff requested in a different order is the same logical command —
 * so the ids are sorted before hashing. The derived `periodEnd` is included
 * so the receipt is bound to the canonical period, not just its start.
 */
export function weeklyReportBulkRequestHash(input: {
  staffUserIds: readonly string[];
  periodStart: string;
  periodEnd: string;
  questions: unknown;
  instructions: string | null;
}): string {
  // The deadline is server-canonical (periodEnd + 1), so — exactly like the
  // single create — the request identity carries no caller-provided dueDate
  // dimension.
  return hashRequestIdentity({
    operation: 'WEEKLY_REPORT_BULK_REQUEST:v1',
    staffUserIds: [...input.staffUserIds].sort(),
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    questions: input.questions,
    instructions: input.instructions,
  });
}

export function weeklyReportAlreadyExists(
  reportId: string,
  jobCardId: string,
  periodStart: string,
): AppError {
  return new AppError(
    'WEEKLY_REPORT_ALREADY_EXISTS',
    409,
    'Bu personel için bu haftaya ait rapor zaten mevcut.',
    { reportId, jobCardId, periodStart },
  );
}
