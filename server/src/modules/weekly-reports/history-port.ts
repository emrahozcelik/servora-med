import type { JobCardActor, JobCardStatus } from '../job-cards/types.js';

/**
 * Bounded Weekly Report history read model for personnel profiles.
 *
 * This is a *read model*, not a second reporting system: one row per canonical
 * `weekly_reports` record, enriched with the owning JobCard's lifecycle status
 * (the lifecycle authority) and a submission aggregate derived from the
 * immutable `weekly_report_submissions` rows.
 *
 * It deliberately carries no report content: no draft body, no frozen body and
 * no frozen source-work. Content stays behind the report detail and submission
 * endpoints so the profile list cannot become an alternate content surface.
 */
export type WeeklyReportHistoryItem = {
  reportId: string;
  jobCardId: string;
  staffUserId: string;
  /** Organization-local calendar date (`YYYY-MM-DD`), a Monday. */
  periodStart: string;
  /** Organization-local calendar date (`YYYY-MM-DD`), the following Sunday. */
  periodEnd: string;
  /** Canonical lifecycle status — owned by the backing JobCard, never duplicated. */
  status: JobCardStatus;
  dueDate: string | null;
  /** Immutable submission count; `0` for a report that was never submitted. */
  submissionCount: number;
  /** Highest frozen `seq_no`, or `null` when there are no submissions. */
  latestSubmissionSeqNo: number | null;
  /** Server-owned `submittedAt` of the highest seq, or `null`. */
  latestSubmittedAt: string | null;
  createdAt: string;
  /** JobCard approval instant; `null` until the report reaches COMPLETED. */
  completedAt: string | null;
};

export type PaginatedWeeklyReportHistory = {
  items: WeeklyReportHistoryItem[];
  total: number;
  limit: number;
  offset: number;
};

export type StaffWeeklyReportHistoryQuery = {
  organizationId: string;
  /** Report owner. The caller resolves this (`/staff/me` uses the actor id). */
  targetUserId: string;
  actor: JobCardActor;
  limit: number;
  offset: number;
};

/**
 * Explicit read port for the personnel-profile history surface. Kept separate
 * from the JobCard service so the profile read path never depends on the whole
 * lifecycle implementation.
 */
export interface WeeklyReportHistoryReadPort {
  listForStaff(input: StaffWeeklyReportHistoryQuery): Promise<PaginatedWeeklyReportHistory>;
}
