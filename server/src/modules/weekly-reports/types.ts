import type { JobCardStatus, JobCardType } from '../job-cards/types.js';

/** Canonical Monday-Sunday reporting week, both bounds as local `YYYY-MM-DD`. */
export type WeeklyReportPeriod = {
  periodStart: string;
  periodEnd: string;
};

/**
 * Manager-defined question. Definitions are frozen at report creation;
 * managers use notes for later clarification (no question-definition edits).
 */
export type ManagerQuestion = {
  key: string;
  prompt: string;
};

/** Staff answer referencing its question by stable key. */
export type ManagerAnswer = {
  questionKey: string;
  answer: string;
};

/** Editable draft body. Null = not written yet (draft in progress). */
export type WeeklyReportDraftBody = {
  summary: string | null;
  blockers: string | null;
  nextWeekPlan: string | null;
  highlights: string | null;
  fieldObservations: string | null;
  supportNeeded: string | null;
};

/** Frozen submission body: required sections resolved to text, rest optional. */
export type WeeklyReportSubmittedBody = {
  summary: string;
  blockers: string | null;
  nextWeekPlan: string;
  highlights: string | null;
  fieldObservations: string | null;
  supportNeeded: string | null;
};

/**
 * Minimum frozen source-work item for historical integrity. Display names
 * (not live joins) so later renames cannot rewrite a submitted report.
 */
export type SourceWorkSnapshotItem = {
  jobCardId: string;
  type: JobCardType;
  title: string;
  customerName: string | null;
  staffCompletedAt: string;
  statusAtSnapshot: Extract<JobCardStatus, 'WAITING_APPROVAL' | 'COMPLETED'>;
};

/**
 * Raw source-work candidate row as read inside a JobCard transaction: the
 * service maps it to {@link SourceWorkSnapshotItem} through the pure
 * `mapSourceWorkRow` helper (same file family: `source-work.ts`).
 */
export type WeeklySourceWorkRow = {
  jobCardId: string;
  type: string;
  title: string;
  customerName: string | null;
  staffCompletedAt: Date;
  status: string;
};

export type WeeklyReportSubmissionSummary = {
  seqNo: number;
  submittedAt: string;
  submittedBy: string;
};

/**
 * Report detail DTO: weekly domain state plus the owning JobCard lifecycle
 * reference, the bounded live source-work list (editable statuses only) and
 * submission summaries (full frozen payloads via the history read).
 */
export type WeeklyReportDetail = WeeklyReport & {
  jobStatus: JobCardStatus;
  jobVersion: number;
  dueDate: string | null;
  assignedTo: string;
  /**
   * Manager request instructions (JobCard `description`). Read-only for the
   * assigned STAFF: it is the manager's request intent, not report content.
   * Sourced from the owning JobCard, never duplicated into the report row.
   */
  instructions: string | null;
  liveSourceWork: SourceWorkSnapshotItem[];
  submissionSummaries: WeeklyReportSubmissionSummary[];
};

export type WeeklyReport = {
  id: string;
  organizationId: string;
  jobCardId: string;
  staffUserId: string;
  periodStart: string;
  periodEnd: string;
  draft: WeeklyReportDraftBody;
  questions: ManagerQuestion[];
  answers: ManagerAnswer[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WeeklyReportSubmission = {
  id: string;
  organizationId: string;
  weeklyReportId: string;
  jobCardId: string;
  seqNo: number;
  submittedBy: string;
  submittedAt: string;
  periodStart: string;
  periodEnd: string;
  body: WeeklyReportSubmittedBody;
  questions: ManagerQuestion[];
  answers: ManagerAnswer[];
  sourceWork: SourceWorkSnapshotItem[];
  jobVersion: number;
  sourceActivityId: string;
  createdAt: string;
};
