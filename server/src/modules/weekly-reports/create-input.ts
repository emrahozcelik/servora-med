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
  'clientActionId', 'periodStart', 'assignedTo', 'dueDate', 'questions', 'instructions',
] as const;

/**
 * Public single-report creation intent. A dedicated command (not generic
 * JobCard create with WeeklyReport-only optionals): the only accepted type
 * is WEEKLY_REPORT and the payload carries exactly the report dimensions.
 */
export type WeeklyReportCreateInput = {
  clientActionId: string;
  /** Canonical Monday; service derives periodEnd +6 and default due date. */
  periodStart: string;
  periodEnd: string;
  /** Null = self (STAFF path); uuid = single target (MANAGER/ADMIN path). */
  assignedTo: string | null;
  /** Null = default (Monday after period_end); otherwise explicit ISO date. */
  dueDate: string | null;
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
  const dueDate = record.dueDate === undefined || record.dueDate === null
    ? null
    : isoDate(record.dueDate, 'dueDate');
  const instructions = optionalBoundedString(
    record.instructions, 'instructions', MAX_REQUEST_INSTRUCTIONS_LENGTH,
  );
  return {
    clientActionId,
    periodStart,
    periodEnd,
    assignedTo,
    dueDate,
    questions: record.questions,
    instructions,
  };
}

/** Deterministic neutral title: ISO dates only, no locale month names. */
export function weeklyReportTitle(periodStart: string, periodEnd: string): string {
  return `Haftalık Rapor (${periodStart} – ${periodEnd})`;
}

export function weeklyReportCreateRequestHash(input: {
  periodStart: string;
  periodEnd: string;
  assignedTo: string | null;
  dueDate: string | null;
  questions: unknown;
  instructions: string | null;
}): string {
  // Same critical-action hashing contract as generic creates: normalized
  // intent only (clientActionId/requestTime/generated ids never hashed).
  // Callers pass validated canonical questions, never raw input.
  return hashRequestIdentity({
    operation: 'WEEKLY_REPORT_CREATE:v1',
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    assignedTo: input.assignedTo,
    dueDate: input.dueDate,
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
