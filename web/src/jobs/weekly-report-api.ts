import {
  ApiError, json, nullableString, object, request, requestBinary, string,
} from '../services/api';
import {
  JOB_CARD_STATUSES,
  JOB_CARD_TYPES,
  type JobCardStatus,
} from './jobs-api';

// Local parser helpers mirror the jobs-api convention (each API module owns
// its exact-object parsing so contract drift fails closed at the call site).
function invalid(field: string): never {
  throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return invalid(field);
}

function array(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) return value;
  return invalid(field);
}

function exactObject(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  const record = object(value);
  if (Object.keys(record).some((key) => !keys.includes(key))) invalid(field);
  return record;
}

function dateKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(field);
  return value;
}

function positiveCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) invalid(field);
  return value;
}

export type WeeklyReportQuestion = { key: string; prompt: string };
export type WeeklyReportAnswer = { questionKey: string; answer: string };
export type WeeklyReportDraft = {
  summary: string | null;
  blockers: string | null;
  nextWeekPlan: string | null;
  highlights: string | null;
  fieldObservations: string | null;
  supportNeeded: string | null;
};
export type WeeklySourceWorkItem = {
  jobCardId: string;
  type: string;
  title: string;
  customerName: string | null;
  staffCompletedAt: string;
  statusAtSnapshot: 'WAITING_APPROVAL' | 'COMPLETED';
};
export type WeeklyReportSubmissionSummary = {
  seqNo: number;
  submittedAt: string;
  submittedBy: string;
};
export type WeeklyReportDetail = {
  id: string;
  staffUserId: string;
  jobCardId: string;
  periodStart: string;
  periodEnd: string;
  draft: WeeklyReportDraft;
  questions: WeeklyReportQuestion[];
  answers: WeeklyReportAnswer[];
  version: number;
  jobStatus: JobCardStatus;
  jobVersion: number;
  dueDate: string | null;
  assignedTo: string;
  /** Manager request instructions (JobCard description). Read-only for STAFF. */
  instructions: string | null;
  liveSourceWork: WeeklySourceWorkItem[];
  submissionSummaries: WeeklyReportSubmissionSummary[];
};
/**
 * Canonical create-screen reference. The organization timezone owns what
 * "this week" means, so the default period is never derived from the device
 * clock.
 */
export type WeeklyReportReference = {
  timezone: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
};
export type WeeklyReportSubmission = {
  id: string;
  weeklyReportId: string;
  jobCardId: string;
  seqNo: number;
  submittedBy: string;
  submittedAt: string;
  periodStart: string;
  periodEnd: string;
  body: {
    summary: string;
    blockers: string | null;
    nextWeekPlan: string;
    highlights: string | null;
    fieldObservations: string | null;
    supportNeeded: string | null;
  };
  questions: WeeklyReportQuestion[];
  answers: WeeklyReportAnswer[];
  sourceWork: WeeklySourceWorkItem[];
  jobVersion: number;
  sourceActivityId: string;
};
export type WeeklyReportCreateResult = {
  jobCardId: string;
  reportId: string;
  staffUserId: string;
  periodStart: string;
  periodEnd: string;
  status: JobCardStatus;
  dueDate: string | null;
};

/**
 * Server-authoritative ceiling for one bulk command. Mirrored here only so the
 * multi-select can refuse an oversized selection before the request; the
 * backend remains the enforcing owner.
 */
export const MAX_BULK_TARGETS = 50;

export type WeeklyReportBulkOutcome = 'created' | 'existing';

export type WeeklyReportBulkItem = {
  staffUserId: string;
  jobCardId: string;
  reportId: string;
  outcome: WeeklyReportBulkOutcome;
};

/**
 * One logical bulk command, one item per requested staff id in request order.
 * `existing` carries the already-canonical report for that staff/week, so a
 * duplicate is navigable instead of being an error.
 */
export type WeeklyReportBulkResult = {
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  items: WeeklyReportBulkItem[];
};

export type WeeklyReportBulkRequestInput = {
  clientActionId: string;
  staffUserIds: string[];
  periodStart: string;
  dueDate?: string | null;
  questions?: { key: string; prompt: string }[];
  instructions?: string | null;
};

function parseQuestion(value: unknown): WeeklyReportQuestion {
  const entry = exactObject(value, 'question', ['key', 'prompt']);
  return { key: string(entry.key, 'question.key'), prompt: string(entry.prompt, 'question.prompt') };
}

function parseAnswer(value: unknown): WeeklyReportAnswer {
  const entry = exactObject(value, 'answer', ['questionKey', 'answer']);
  return {
    questionKey: string(entry.questionKey, 'answer.questionKey'),
    answer: string(entry.answer, 'answer.answer'),
  };
}

function parseDraft(value: unknown): WeeklyReportDraft {
  const body = exactObject(value, 'draft', [
    'summary', 'blockers', 'nextWeekPlan', 'highlights', 'fieldObservations', 'supportNeeded',
  ]);
  const section = (entry: unknown, field: string) =>
    entry === null ? null : string(entry, field);
  return {
    summary: section(body.summary, 'draft.summary'),
    blockers: section(body.blockers, 'draft.blockers'),
    nextWeekPlan: section(body.nextWeekPlan, 'draft.nextWeekPlan'),
    highlights: section(body.highlights, 'draft.highlights'),
    fieldObservations: section(body.fieldObservations, 'draft.fieldObservations'),
    supportNeeded: section(body.supportNeeded, 'draft.supportNeeded'),
  };
}

function parseSourceWorkItem(value: unknown): WeeklySourceWorkItem {
  const entry = exactObject(value, 'sourceWork', [
    'jobCardId', 'type', 'title', 'customerName', 'staffCompletedAt', 'statusAtSnapshot',
  ]);
  return {
    jobCardId: string(entry.jobCardId, 'sourceWork.jobCardId'),
    type: string(entry.type, 'sourceWork.type'),
    title: string(entry.title, 'sourceWork.title'),
    customerName: entry.customerName === null ? null : string(entry.customerName, 'sourceWork.customerName'),
    staffCompletedAt: string(entry.staffCompletedAt, 'sourceWork.staffCompletedAt'),
    statusAtSnapshot: oneOf(entry.statusAtSnapshot, 'sourceWork.statusAtSnapshot', [
      'WAITING_APPROVAL', 'COMPLETED',
    ] as const),
  };
}

function parseSummary(value: unknown): WeeklyReportSubmissionSummary {
  const entry = exactObject(value, 'submissionSummary', ['seqNo', 'submittedAt', 'submittedBy']);
  return {
    seqNo: positiveCount(entry.seqNo, 'submissionSummary.seqNo'),
    submittedAt: string(entry.submittedAt, 'submissionSummary.submittedAt'),
    submittedBy: string(entry.submittedBy, 'submissionSummary.submittedBy'),
  };
}

export function parseWeeklyReportDetail(value: unknown): WeeklyReportDetail {
  const root = exactObject(value, 'weeklyReport', [
    'id', 'staffUserId', 'jobCardId', 'periodStart', 'periodEnd', 'draft',
    'questions', 'answers', 'version', 'jobStatus', 'jobVersion', 'dueDate',
    'assignedTo', 'instructions', 'liveSourceWork', 'submissionSummaries',
  ]);
  return {
    id: string(root.id, 'id'),
    staffUserId: string(root.staffUserId, 'staffUserId'),
    jobCardId: string(root.jobCardId, 'jobCardId'),
    periodStart: dateKey(root.periodStart, 'periodStart'),
    periodEnd: dateKey(root.periodEnd, 'periodEnd'),
    draft: parseDraft(root.draft),
    questions: array(root.questions, 'questions').map(parseQuestion),
    answers: array(root.answers, 'answers').map(parseAnswer),
    version: positiveCount(root.version, 'version'),
    jobStatus: oneOf(root.jobStatus, 'jobStatus', JOB_CARD_STATUSES),
    jobVersion: positiveCount(root.jobVersion, 'jobVersion'),
    dueDate: root.dueDate === null ? null : dateKey(root.dueDate, 'dueDate'),
    assignedTo: string(root.assignedTo, 'assignedTo'),
    instructions: root.instructions === null ? null : string(root.instructions, 'instructions'),
    liveSourceWork: array(root.liveSourceWork, 'liveSourceWork').map(parseSourceWorkItem),
    submissionSummaries: array(root.submissionSummaries, 'submissionSummaries').map(parseSummary),
  };
}

export function parseWeeklyReportReference(value: unknown): WeeklyReportReference {
  const root = exactObject(value, 'weeklyReportReference', [
    'timezone', 'periodStart', 'periodEnd', 'dueDate',
  ]);
  return {
    timezone: string(root.timezone, 'timezone'),
    periodStart: dateKey(root.periodStart, 'periodStart'),
    periodEnd: dateKey(root.periodEnd, 'periodEnd'),
    dueDate: dateKey(root.dueDate, 'dueDate'),
  };
}

export function parseWeeklyReportSubmission(value: unknown): WeeklyReportSubmission {
  const root = exactObject(value, 'submission', [
    'id', 'weeklyReportId', 'jobCardId', 'seqNo', 'submittedBy', 'submittedAt',
    'periodStart', 'periodEnd', 'body', 'questions', 'answers', 'sourceWork',
    'jobVersion', 'sourceActivityId',
  ]);
  const body = exactObject(root.body, 'submission.body', [
    'summary', 'blockers', 'nextWeekPlan', 'highlights', 'fieldObservations', 'supportNeeded',
  ]);
  return {
    id: string(root.id, 'id'),
    weeklyReportId: string(root.weeklyReportId, 'weeklyReportId'),
    jobCardId: string(root.jobCardId, 'jobCardId'),
    seqNo: positiveCount(root.seqNo, 'seqNo'),
    submittedBy: string(root.submittedBy, 'submittedBy'),
    submittedAt: string(root.submittedAt, 'submittedAt'),
    periodStart: dateKey(root.periodStart, 'periodStart'),
    periodEnd: dateKey(root.periodEnd, 'periodEnd'),
    body: {
      summary: string(body.summary, 'body.summary'),
      blockers: body.blockers === null ? null : string(body.blockers, 'body.blockers'),
      nextWeekPlan: string(body.nextWeekPlan, 'body.nextWeekPlan'),
      highlights: body.highlights === null ? null : string(body.highlights, 'body.highlights'),
      fieldObservations: body.fieldObservations === null
        ? null
        : string(body.fieldObservations, 'body.fieldObservations'),
      supportNeeded: body.supportNeeded === null ? null : string(body.supportNeeded, 'body.supportNeeded'),
    },
    questions: array(root.questions, 'questions').map(parseQuestion),
    answers: array(root.answers, 'answers').map(parseAnswer),
    sourceWork: array(root.sourceWork, 'sourceWork').map(parseSourceWorkItem),
    jobVersion: positiveCount(root.jobVersion, 'jobVersion'),
    sourceActivityId: string(root.sourceActivityId, 'sourceActivityId'),
  };
}

export function parseWeeklyReportCreateResult(value: unknown): WeeklyReportCreateResult {
  const root = exactObject(value, 'weeklyReportCreate', [
    'jobCardId', 'reportId', 'staffUserId', 'periodStart', 'periodEnd', 'status', 'dueDate',
  ]);
  return {
    jobCardId: string(root.jobCardId, 'jobCardId'),
    reportId: string(root.reportId, 'reportId'),
    staffUserId: string(root.staffUserId, 'staffUserId'),
    periodStart: dateKey(root.periodStart, 'periodStart'),
    periodEnd: dateKey(root.periodEnd, 'periodEnd'),
    status: oneOf(root.status, 'status', JOB_CARD_STATUSES),
    dueDate: root.dueDate === null ? null : dateKey(root.dueDate, 'dueDate'),
  };
}

export type WeeklyReportCreateInput = {
  clientActionId: string;
  periodStart: string;
  assignedTo?: string | null;
  dueDate?: string | null;
  questions?: { key: string; prompt: string }[];
  instructions?: string | null;
};

function parseBulkItem(value: unknown): WeeklyReportBulkItem {
  const entry = exactObject(value, 'bulkItem', ['staffUserId', 'jobCardId', 'reportId', 'outcome']);
  return {
    staffUserId: string(entry.staffUserId, 'bulkItem.staffUserId'),
    jobCardId: string(entry.jobCardId, 'bulkItem.jobCardId'),
    reportId: string(entry.reportId, 'bulkItem.reportId'),
    outcome: oneOf(entry.outcome, 'bulkItem.outcome', ['created', 'existing'] as const),
  };
}

export function parseWeeklyReportBulkResult(value: unknown): WeeklyReportBulkResult {
  const root = exactObject(value, 'weeklyReportBulk', [
    'periodStart', 'periodEnd', 'dueDate', 'items',
  ]);
  return {
    periodStart: dateKey(root.periodStart, 'periodStart'),
    periodEnd: dateKey(root.periodEnd, 'periodEnd'),
    dueDate: dateKey(root.dueDate, 'dueDate'),
    items: array(root.items, 'items').map(parseBulkItem),
  };
}

export type WeeklyReportDraftPatchInput = {
  expectedVersion: number;
  draft: WeeklyReportDraft;
  answers: WeeklyReportAnswer[];
};

const weeklyPath = (jobCardId: string) => `/api/job-cards/${encodeURIComponent(jobCardId)}/weekly-report`;

export const createWeeklyReport = async (input: WeeklyReportCreateInput) =>
  parseWeeklyReportCreateResult(await request('/api/job-cards/weekly-reports', json('POST', input)));

/**
 * Manager/ADMIN bulk request. One command, N independent reports — the client
 * never loops the single-create endpoint per staff member.
 */
export const bulkRequestWeeklyReports = async (input: WeeklyReportBulkRequestInput) =>
  parseWeeklyReportBulkResult(await request(
    '/api/job-cards/weekly-reports/bulk-request', json('POST', input),
  ));

/** Canonical organization-local current reporting week (create-screen default). */
export const getWeeklyReportReference = async () =>
  parseWeeklyReportReference(await request('/api/job-cards/weekly-reports/reference'));

export const getWeeklyReport = async (jobCardId: string) =>
  parseWeeklyReportDetail(await request(weeklyPath(jobCardId)));

export const patchWeeklyReportDraft = async (jobCardId: string, input: WeeklyReportDraftPatchInput) =>
  parseWeeklyReportDetail(await request(weeklyPath(jobCardId), json('PATCH', input)));

export const listWeeklyReportSubmissions = async (jobCardId: string) =>
  array(await request(`${weeklyPath(jobCardId)}/submissions`), 'submissions').map(
    parseWeeklyReportSubmission,
  );

/**
 * Download the PDF for one immutable submission version. Uses the binary
 * transport (never the JSON parser) and never mutates server state: the server
 * renders from the frozen submission row selected by `seqNo`.
 */
export const downloadWeeklyReportSubmissionPdf = async (
  jobCardId: string,
  seqNo: number,
): Promise<{ blob: Blob; fileName: string }> => {
  const response = await requestBinary(
    `${weeklyPath(jobCardId)}/submissions/${encodeURIComponent(String(seqNo))}/pdf`,
  );
  return {
    blob: response.blob,
    // The server owns the canonical filename (it is the naming authority and
    // ships it in Content-Disposition); this is only a last-resort fallback.
    fileName: response.fileName ?? `haftalik-rapor-seq-${seqNo}.pdf`,
  };
};
