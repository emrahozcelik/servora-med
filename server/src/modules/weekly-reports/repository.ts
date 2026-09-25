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

function alreadyExists(): AppError {
  return new AppError(
    'WEEKLY_REPORT_ALREADY_EXISTS',
    409,
    'Bu personel için bu haftaya ait rapor zaten mevcut.',
  );
}

function jobAlreadyAttached(): AppError {
  return new AppError(
    'WEEKLY_REPORT_JOB_ATTACHED',
    409,
    'Bu iş kaydı zaten bir haftalık rapora bağlı.',
  );
}

function sourceMismatch(): AppError {
  return new AppError(
    'WEEKLY_REPORT_SOURCE_MISMATCH',
    409,
    'Gönderim kaynağı doğrulanamadı.',
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === '23505'
  );
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    !!error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === '23503'
  );
}

function constraintName(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const name = (error as { constraint?: unknown }).constraint;
  return typeof name === 'string' ? name : null;
}

// Auto-generated PostgreSQL constraint names (verified against the live
// schema; stable unless migration 051 is rewritten, which is forbidden).
const STAFF_WEEK_UNIQUE_CONSTRAINT =
  'weekly_reports_organization_id_staff_user_id_period_start_key';
const JOB_ATTACH_UNIQUE_CONSTRAINT =
  'weekly_reports_organization_id_job_card_id_key';

/**
 * Constraint-specific duplicate semantics (F3): only the two known identity
 * conflicts map to domain errors. Any other unique violation is rethrown
 * unmasked — never converted into a misleading "report already exists".
 */
function duplicateReportFor(error: unknown): AppError | null {
  if (!isUniqueViolation(error)) return null;
  const name = constraintName(error);
  if (name === STAFF_WEEK_UNIQUE_CONSTRAINT) return alreadyExists();
  if (name === JOB_ATTACH_UNIQUE_CONSTRAINT) return jobAlreadyAttached();
  return null;
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

/** Minimal query surface: Pool and single transaction clients both satisfy it. */
export type WeeklyQueryable = {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

export type WeeklyDraftRowUpdate = {
  organizationId: string;
  reportId: string;
  expectedVersion: number;
  draft: WeeklyReportDraftBody;
  answers: ManagerAnswer[];
};

/**
 * Version-guarded draft replacement shared by the standalone repository and
 * the JobCard service path. Returns null on stale version (caller maps to
 * VERSION_CONFLICT). Complete replacement, never sparse merge.
 */
export async function updateWeeklyReportDraftRow(
  executor: WeeklyQueryable,
  input: WeeklyDraftRowUpdate,
): Promise<WeeklyReportRow | null> {
  const result = await executor.query<WeeklyReportRow>(
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
      input.draft.summary,
      input.draft.blockers,
      input.draft.nextWeekPlan,
      input.draft.highlights,
      input.draft.fieldObservations,
      input.draft.supportNeeded,
      JSON.stringify(input.answers),
      input.expectedVersion,
    ],
  );
  return result.rows[0] ?? null;
}

export async function listWeeklyReportSubmissionRows(
  executor: WeeklyQueryable,
  organizationId: string,
  reportId: string,
): Promise<WeeklyReportSubmissionRow[]> {
  const result = await executor.query<WeeklyReportSubmissionRow>(
    `SELECT * FROM weekly_report_submissions
      WHERE organization_id = $1 AND weekly_report_id = $2
      ORDER BY seq_no ASC, id ASC`,
    [organizationId, reportId],
  );
  return result.rows;
}

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

  /**
   * Standalone report creation.
   *
   * PRECONDITION — NOT WIRED INTO ANY PRODUCTION COMMAND. Do not wire it
   * without first adding the ordered user lock.
   *
   * Every production writer of `weekly_reports`
   * (`JobCardService.createWeeklyReport` and `bulkRequestWeeklyReports`) goes
   * through `createOrResolveWeeklyReportForStaff`, which takes
   * `lockUsersInOrder` → `getAssigneeForUpdate` before inserting, so two
   * concurrent creates for the same staff/week serialize on the `users` row.
   * This method instead issues a bare `INSERT … RETURNING *` with no such
   * lock: on a lost race it depends entirely on the `weekly_reports` unique
   * constraint and maps the resulting 23505 to `WEEKLY_REPORT_ALREADY_EXISTS`
   * / `WEEKLY_REPORT_JOB_ATTACHED` via `duplicateReportFor`. It therefore
   * *reports a conflict* rather than converging to the winning report, and a
   * caller that wraps it in a transaction will observe that transaction abort.
   *
   * Today it is reachable only from its own contract test
   * (`tests/weekly-report-repository-postgres.test.ts`); `app.ts` wires the
   * JobCard path only. Before any production wiring, either route the caller
   * through `createOrResolveWeeklyReportForStaff` or take the same ordered user
   * lock here. Left in place (not deleted, not refactored) to keep the change
   * surgical.
   */
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
      const duplicate = duplicateReportFor(error);
      if (duplicate) throw duplicate;
      // A referenced job/staff row deleted between the pre-checks and the
      // insert: deterministic not-found, never a raw FK leak.
      if (isForeignKeyViolation(error)) throw notFound();
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
    const next = await updateWeeklyReportDraftRow(this.pool, {
      organizationId: input.organizationId,
      reportId: input.reportId,
      expectedVersion: input.expectedVersion,
      draft,
      answers,
    });
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
    // F4: the submission clock is server-owned. Direct callers must supply a
    // real instant; the production service path always passes its request
    // clock and never client time.
    if (!(input.submittedAt instanceof Date)
      || Number.isNaN(input.submittedAt.valueOf())) {
      throw new AppError('VALIDATION_ERROR', 400, 'submittedAt geçersizdir.', {
        fieldErrors: { submittedAt: 'submittedAt geçersizdir.' },
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
      // F2: a source activity from another job/organization (or deleted
      // mid-flight) violates the composite FK. Deterministic domain error —
      // raw 23503 never escapes.
      if (isForeignKeyViolation(error)) throw sourceMismatch();
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
    const rows = await listWeeklyReportSubmissionRows(this.pool, organizationId, reportId);
    return rows.map(mapSubmission);
  }
}
