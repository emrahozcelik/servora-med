import type { Pool } from 'pg';

import { AppError } from '../../errors/index.js';
import type {
  ManagerAnswer,
  ManagerQuestion,
  SourceWorkSnapshotItem,
  WeeklyReport,
  WeeklyReportDraftBody,
  WeeklyReportSubmittedBody,
  WeeklyReportSubmission,
} from './types.js';
import {
  parsePeriodStart,
  validateDraftAnswers,
  validateDraftBody,
  validateManagerQuestions,
  validateSourceWorkSnapshot,
  validateSubmissionAnswers,
  validateSubmissionBody,
} from './validation.js';

function notFound(): AppError {
  return new AppError(
    'WEEKLY_REPORT_NOT_FOUND',
    404,
    'Haftalık rapor bulunamadı.',
  );
}

function forbidden(): AppError {
  return new AppError(
    'FORBIDDEN',
    403,
    'Bu işlem için yetkiniz bulunmuyor.',
  );
}

function versionConflict(): AppError {
  return new AppError(
    'VERSION_CONFLICT',
    409,
    'Rapor başka bir işlem tarafından güncellendi.',
  );
}

function duplicateReport(): AppError {
  return new AppError(
    'WEEKLY_REPORT_CONFLICT',
    409,
    'Bu personel için bu haftaya ait rapor zaten mevcut.',
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === '23505'
  );
}

export type WeeklyReportRow = {
  id: string;
  organization_id: string;
  job_card_id: string;
  staff_user_id: string;
  period_start: Date;
  period_end: Date;
  draft_summary: string | null;
  draft_blockers: string | null;
  draft_next_week_plan: string | null;
  draft_highlights: string | null;
  draft_field_observations: string | null;
  draft_support_needed: string | null;
  manager_questions: ManagerQuestion[];
  manager_answers: ManagerAnswer[];
  version: number;
  created_at: Date;
  updated_at: Date;
};

export type WeeklyReportSubmissionRow = {
  id: string;
  organization_id: string;
  weekly_report_id: string;
  job_card_id: string;
  seq_no: number;
  submitted_by: string;
  submitted_at: Date;
  period_start: Date;
  period_end: Date;
  frozen_body: WeeklyReportSubmittedBody;
  frozen_questions: ManagerQuestion[];
  frozen_answers: ManagerAnswer[];
  frozen_source_work: SourceWorkSnapshotItem[];
  job_version: number;
  source_activity_id: string;
  created_at: Date;
};

/**
 * Host-timezone-independent DATE mapping (same convention as the JobCard
 * repository's `mapCalendarDate`): node-pg materializes DATE as local
 * midnight, so local calendar fields round-trip on any host while
 * `toISOString()` would shift the day outside UTC.
 */
export function dateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function mapReport(row: WeeklyReportRow): WeeklyReport {
  return {
    id: row.id,
    organizationId: row.organization_id,
    jobCardId: row.job_card_id,
    staffUserId: row.staff_user_id,
    periodStart: dateKey(row.period_start),
    periodEnd: dateKey(row.period_end),
    draft: {
      summary: row.draft_summary,
      blockers: row.draft_blockers,
      nextWeekPlan: row.draft_next_week_plan,
      highlights: row.draft_highlights,
      fieldObservations: row.draft_field_observations,
      supportNeeded: row.draft_support_needed,
    },
    questions: row.manager_questions,
    answers: row.manager_answers,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function mapSubmission(row: WeeklyReportSubmissionRow): WeeklyReportSubmission {
  return {
    id: row.id,
    organizationId: row.organization_id,
    weeklyReportId: row.weekly_report_id,
    jobCardId: row.job_card_id,
    seqNo: row.seq_no,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at.toISOString(),
    periodStart: dateKey(row.period_start),
    periodEnd: dateKey(row.period_end),
    body: row.frozen_body,
    questions: row.frozen_questions,
    answers: row.frozen_answers,
    sourceWork: row.frozen_source_work,
    jobVersion: row.job_version,
    sourceActivityId: row.source_activity_id,
    createdAt: row.created_at.toISOString(),
  };
}

export type CreateWeeklyReportInput = {
  organizationId: string;
  jobCardId: string;
  staffUserId: string;
  /** Local `YYYY-MM-DD`; must be a Monday. `periodEnd` derives as +6 days. */
  periodStart: string;
  questions: unknown;
};

export type UpdateWeeklyReportDraftInput = {
  organizationId: string;
  reportId: string;
  /** Acting user; must equal the report's staff owner (staff authorship). */
  staffUserId: string;
  expectedVersion: number;
  draft: unknown;
  answers: unknown;
};

export type AppendWeeklyReportSubmissionInput = {
  organizationId: string;
  reportId: string;
  /** Must equal the report's staff owner (staff authorship). */
  submittedBy: string;
  submittedAt: Date;
  draft: unknown;
  answers: unknown;
  sourceWork: unknown;
  jobVersion: number;
  sourceActivityId: string;
};

/**
 * Persistence for Weekly Reports (V1 Slice 1 foundation).
 *
 * Ownership model: every report row is tenant-scoped and staff-owned. Draft
 * writes and submissions require the acting staff user to equal
 * `staff_user_id`; anything else fails closed. Submission rows are
 * append-only: this repository exposes no update or delete path for
 * submission content (same application-discipline convention as the
 * Foundation history tables).
 */
export class PostgresWeeklyReportRepository {
  constructor(private readonly pool: Pool) {}

  async createReport(input: CreateWeeklyReportInput): Promise<WeeklyReport> {
    const { periodStart, periodEnd } = parsePeriodStart(input.periodStart);
    const questions = validateManagerQuestions(input.questions);
    const job = await this.pool.query<{ type: string }>(
      `SELECT type FROM job_cards WHERE organization_id = $1 AND id = $2`,
      [input.organizationId, input.jobCardId],
    );
    const jobRow = job.rows[0];
    if (!jobRow) throw notFound();
    if (jobRow.type !== 'WEEKLY_REPORT') {
      throw new AppError(
        'INVALID_JOB_TYPE',
        409,
        'Haftalık rapor kaydı yalnız haftalık rapor işlerine bağlanabilir.',
      );
    }
    const staff = await this.pool.query<{ role: string; is_active: boolean }>(
      `SELECT role, is_active FROM users WHERE organization_id = $1 AND id = $2`,
      [input.organizationId, input.staffUserId],
    );
    const staffRow = staff.rows[0];
    if (!staffRow || staffRow.role !== 'STAFF' || !staffRow.is_active) {
      throw forbidden();
    }
    try {
      const result = await this.pool.query<WeeklyReportRow>(
        `INSERT INTO weekly_reports
           (organization_id, job_card_id, staff_user_id, period_start, period_end,
            manager_questions, manager_answers)
         VALUES ($1, $2, $3, $4, $5, $6, '[]')
         RETURNING *`,
        [
          input.organizationId,
          input.jobCardId,
          input.staffUserId,
          periodStart,
          periodEnd,
          JSON.stringify(questions),
        ],
      );
      return mapReport(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateReport();
      throw error;
    }
  }

  async getReport(organizationId: string, reportId: string): Promise<WeeklyReport | null> {
    const result = await this.pool.query<WeeklyReportRow>(
      `SELECT * FROM weekly_reports WHERE organization_id = $1 AND id = $2`,
      [organizationId, reportId],
    );
    const row = result.rows[0];
    return row ? mapReport(row) : null;
  }

  async getReportByStaffWeek(
    organizationId: string,
    staffUserId: string,
    periodStart: string,
  ): Promise<WeeklyReport | null> {
    const result = await this.pool.query<WeeklyReportRow>(
      `SELECT * FROM weekly_reports
        WHERE organization_id = $1 AND staff_user_id = $2 AND period_start = $3`,
      [organizationId, staffUserId, periodStart],
    );
    const row = result.rows[0];
    return row ? mapReport(row) : null;
  }

  async updateDraft(input: UpdateWeeklyReportDraftInput): Promise<WeeklyReport> {
    const draft = validateDraftBody(input.draft);
    const current = await this.pool.query<WeeklyReportRow>(
      `SELECT * FROM weekly_reports WHERE organization_id = $1 AND id = $2`,
      [input.organizationId, input.reportId],
    );
    const row = current.rows[0];
    if (!row) throw notFound();
    if (row.staff_user_id !== input.staffUserId) throw forbidden();
    if (row.version !== input.expectedVersion) throw versionConflict();
    const answers = validateDraftAnswers(row.manager_questions, input.answers);
    const updated = await this.pool.query<WeeklyReportRow>(
      `UPDATE weekly_reports
          SET draft_summary = $3, draft_blockers = $4, draft_next_week_plan = $5,
              draft_highlights = $6, draft_field_observations = $7,
              draft_support_needed = $8, manager_answers = $9,
              version = version + 1, updated_at = NOW()
        WHERE organization_id = $1 AND id = $2 AND version = $10
        RETURNING *`,
      [
        input.organizationId,
        input.reportId,
        draft.summary,
        draft.blockers,
        draft.nextWeekPlan,
        draft.highlights,
        draft.fieldObservations,
        draft.supportNeeded,
        JSON.stringify(answers),
        input.expectedVersion,
      ],
    );
    const next = updated.rows[0];
    // Lost-update race between the read and the write: same deterministic
    // conflict as a stale caller version.
    if (!next) throw versionConflict();
    return mapReport(next);
  }

  async appendSubmission(
    input: AppendWeeklyReportSubmissionInput,
  ): Promise<WeeklyReportSubmission> {
    if (!Number.isInteger(input.jobVersion) || input.jobVersion < 1) {
      throw new AppError('VALIDATION_ERROR', 400, 'jobVersion geçersizdir.', {
        fieldErrors: { jobVersion: 'jobVersion geçersizdir.' },
      });
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<WeeklyReportRow>(
        `SELECT * FROM weekly_reports
          WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [input.organizationId, input.reportId],
      );
      const row = current.rows[0];
      if (!row) throw notFound();
      if (row.staff_user_id !== input.submittedBy) throw forbidden();
      const body = validateSubmissionBody(validateDraftBody(input.draft));
      const answers = validateSubmissionAnswers(row.manager_questions, input.answers);
      const sourceWork = validateSourceWorkSnapshot(input.sourceWork);
      const seq = await client.query<{ seq_no: number }>(
        `SELECT COALESCE(MAX(seq_no), 0) + 1 AS seq_no FROM weekly_report_submissions
          WHERE organization_id = $1 AND weekly_report_id = $2`,
        [input.organizationId, input.reportId],
      );
      const nextSeq = seq.rows[0]!.seq_no;
      const inserted = await client.query<WeeklyReportSubmissionRow>(
        `INSERT INTO weekly_report_submissions
           (organization_id, weekly_report_id, job_card_id, seq_no, submitted_by,
            submitted_at, period_start, period_end, frozen_body, frozen_questions,
            frozen_answers, frozen_source_work, job_version, source_activity_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          input.organizationId,
          input.reportId,
          row.job_card_id,
          nextSeq,
          input.submittedBy,
          input.submittedAt,
          dateKey(row.period_start),
          dateKey(row.period_end),
          JSON.stringify(body),
          JSON.stringify(row.manager_questions),
          JSON.stringify(answers),
          JSON.stringify(sourceWork),
          input.jobVersion,
          input.sourceActivityId,
        ],
      );
      await client.query('COMMIT');
      return mapSubmission(inserted.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listSubmissions(
    organizationId: string,
    reportId: string,
  ): Promise<WeeklyReportSubmission[]> {
    const report = await this.pool.query<{ id: string }>(
      `SELECT id FROM weekly_reports WHERE organization_id = $1 AND id = $2`,
      [organizationId, reportId],
    );
    if (!report.rows[0]) throw notFound();
    const result = await this.pool.query<WeeklyReportSubmissionRow>(
      `SELECT * FROM weekly_report_submissions
        WHERE organization_id = $1 AND weekly_report_id = $2
        ORDER BY seq_no ASC, id ASC`,
      [organizationId, reportId],
    );
    return result.rows.map(mapSubmission);
  }
}
