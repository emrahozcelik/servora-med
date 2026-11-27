import { AppError } from '../../errors/index.js';
import type { JobCard, JobCardActor, SubmissionRequirement } from '../job-cards/types.js';
import {
  mapReport,
  type WeeklyReportRow,
  type WeeklyReportSubmissionInsert,
  type WeeklyReportSubmissionRow,
} from './repository.js';
import { mapSourceWorkRow, readWeeklySourceWork, type WeeklyReportSourceWorkReader } from './source-work.js';
import {
  validateSourceWorkSnapshot,
  validateSubmissionAnswers,
  validateSubmissionBody,
} from './validation.js';

export interface WeeklyReportSubmissionReader extends WeeklyReportSourceWorkReader {
  /**
   * Weekly Report backing row for a JobCard submission check, or null when
   * the job has no report. Implemented by the request transaction so the
   * submit path observes the same row it later freezes.
   */
  getWeeklyReportByJobId(
    organizationId: string,
    jobCardId: string,
  ): Promise<WeeklyReportRow | null>;
}

export interface WeeklyReportSubmissionWriter extends WeeklyReportSourceWorkReader {
  /**
   * Weekly Report row locked for a submit freeze. The caller holds the JobCard
   * lock; this adds the report-row lock so draft edits serialize against the
   * submission freeze.
   */
  getWeeklyReportByJobForUpdate(
    organizationId: string,
    jobCardId: string,
  ): Promise<WeeklyReportRow | null>;
  /**
   * Next submission seq, serialized under the caller's report-row lock
   * (getWeeklyReportByJobForUpdate first).
   */
  getNextWeeklyReportSubmissionSeqNo(
    organizationId: string,
    weeklyReportId: string,
  ): Promise<number>;
  /**
   * Append one immutable submission row and bump the report draft version in
   * the same statement pair, so a concurrent draft PATCH with a stale
   * expectedVersion deterministically conflicts after a submit freeze.
   */
  insertWeeklyReportSubmissionRow(
    input: WeeklyReportSubmissionInsert,
  ): Promise<{ submission: WeeklyReportSubmissionRow; reportVersion: number }>;
}

/**
 * Weekly Report submission readiness (V1 Slice 2 form rules). Never falls
 * into meeting requirements: a report has no customer, no meeting details
 * and no delivery items. Authorship is enforced here as well as in the
 * transition guard — only the assigned STAFF may submit their own report.
 *
 * Required: persisted summary + next-week plan; every frozen manager
 * question answered (1..4000 code points). Blockers stay optional and an
 * empty automatic source-work list never blocks submission.
 */
export async function evaluateWeeklyReport(
  reader: WeeklyReportSubmissionReader,
  actor: JobCardActor,
  jobCard: Pick<JobCard, 'id' | 'assignedTo'>,
  assigneeRequirement: SubmissionRequirement,
  assigneeFailure: AppError | null,
): Promise<{ items: SubmissionRequirement[]; failure: AppError | null }> {
  const unauthorized = actor.role !== 'STAFF' || actor.id !== jobCard.assignedTo;
  const missingItems: SubmissionRequirement[] = [
    { code: 'WEEKLY_REPORT_FOUND', state: 'missing', field: 'weeklyReport' },
    assigneeRequirement,
    { code: 'WEEKLY_DRAFT_VALID', state: 'missing', field: 'draft' },
    { code: 'WEEKLY_ANSWERS_COMPLETE', state: 'missing', field: 'managerAnswers' },
    { code: 'WEEKLY_SOURCE_WORK_READY', state: 'missing', field: 'sourceWork' },
  ];
  if (unauthorized) {
    return {
      items: missingItems,
      failure: new AppError(
        'FORBIDDEN',
        403,
        'Haftalık raporu yalnızca atanan personel gönderebilir.',
      ),
    };
  }
  const row = await reader.getWeeklyReportByJobId(
    actor.organizationId,
    jobCard.id,
  );
  if (!row || row.staff_user_id !== actor.id) {
    return {
      items: missingItems,
      failure: new AppError(
        'WEEKLY_REPORT_NOT_FOUND',
        404,
        'Haftalık rapor bulunamadı.',
      ),
    };
  }
  const report = mapReport(row);
  let draftFailure: AppError | null = null;
  try {
    validateSubmissionBody(report.draft);
  } catch (error) {
    draftFailure = error as AppError;
  }
  let answersFailure: AppError | null = null;
  try {
    validateSubmissionAnswers(report.questions, report.answers);
  } catch (error) {
    answersFailure = error as AppError;
  }
  let sourceWorkFailure: AppError | null = null;
  try {
    await readWeeklySourceWork(reader, actor.organizationId, actor.id, report);
  } catch (error) {
    sourceWorkFailure = error as AppError;
  }
  const items: SubmissionRequirement[] = [
    { code: 'WEEKLY_REPORT_FOUND', state: 'met', field: 'weeklyReport' },
    assigneeRequirement,
    { code: 'WEEKLY_DRAFT_VALID', state: draftFailure ? 'missing' : 'met', field: 'draft' },
    {
      code: 'WEEKLY_ANSWERS_COMPLETE',
      state: answersFailure ? 'missing' : 'met',
      field: 'managerAnswers',
    },
    {
      code: 'WEEKLY_SOURCE_WORK_READY',
      state: sourceWorkFailure ? 'invalid' : 'met',
      field: 'sourceWork',
    },
  ];
  return { items, failure: assigneeFailure ?? draftFailure ?? answersFailure ?? sourceWorkFailure };
}

/**
 * Freeze the persisted draft into an immutable submission row inside the
 * caller's SUBMIT_FOR_APPROVAL transaction. The caller holds the JobCard
 * lock and just appended the canonical submit activity; this function locks
 * the report row, re-validates the frozen payload, snapshots live
 * source-work and links the row to that exact activity id (F2: the id
 * comes from our own transition result — clients never supply it).
 * submittedAt is the shared request clock (F4), identical to the
 * staff_completed_at evidence written by the same transition.
 */
export async function appendWeeklyReportSubmission(
  tx: WeeklyReportSubmissionWriter,
  input: {
    organizationId: string;
    staffUserId: string;
    jobCardId: string;
    activityId: string;
    occurredAt: Date;
    jobVersion: number;
  },
): Promise<void> {
  const { organizationId, staffUserId, jobCardId, activityId, occurredAt, jobVersion } = input;
  const row = await tx.getWeeklyReportByJobForUpdate(organizationId, jobCardId);
  if (!row || row.staff_user_id !== staffUserId) {
    throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
  }
  const report = mapReport(row);
  const body = validateSubmissionBody(report.draft);
  const answers = validateSubmissionAnswers(report.questions, report.answers);
  const sourceRows = await readWeeklySourceWork(tx, organizationId, staffUserId, report);
  const sourceWork = validateSourceWorkSnapshot(sourceRows.map(mapSourceWorkRow));
  const seqNo = await tx.getNextWeeklyReportSubmissionSeqNo(organizationId, report.id);
  await tx.insertWeeklyReportSubmissionRow({
    organizationId,
    weeklyReportId: report.id,
    jobCardId,
    seqNo,
    submittedBy: staffUserId,
    submittedAt: occurredAt,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    body,
    questions: report.questions,
    answers,
    sourceWork,
    jobVersion,
    sourceActivityId: activityId,
  });
}
