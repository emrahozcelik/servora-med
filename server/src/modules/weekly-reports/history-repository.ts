import type { Pool } from 'pg';

import type {
  PaginatedWeeklyReportHistory,
  StaffWeeklyReportHistoryQuery,
  WeeklyReportHistoryItem,
  WeeklyReportHistoryReadPort,
} from './history-port.js';
import { dateKey } from './repository.js';

type WeeklyReportHistoryRow = {
  removed_at: Date | null;
  report_id: string;
  job_card_id: string;
  staff_user_id: string;
  period_start: Date | string;
  period_end: Date | string;
  created_at: Date;
  status: WeeklyReportHistoryItem['status'];
  due_date: Date | string | null;
  manager_approved_at: Date | null;
  submission_count: number;
  latest_seq_no: number | null;
  latest_submitted_at: Date | null;
};

function mapCalendarDate(value: Date | string): string {
  return typeof value === 'string' ? value : dateKey(value);
}

function mapWeeklyReportHistoryItem(row: WeeklyReportHistoryRow): WeeklyReportHistoryItem {
  return {
    reportId: row.report_id,
    jobCardId: row.job_card_id,
    staffUserId: row.staff_user_id,
    periodStart: mapCalendarDate(row.period_start),
    periodEnd: mapCalendarDate(row.period_end),
    status: row.status,
    dueDate: row.due_date === null ? null : mapCalendarDate(row.due_date),
    submissionCount: Number(row.submission_count),
    latestSubmissionSeqNo: row.latest_seq_no === null ? null : Number(row.latest_seq_no),
    latestSubmittedAt: row.latest_submitted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    completedAt: row.manager_approved_at?.toISOString() ?? null,
    removedAt: row.removed_at?.toISOString() ?? null,
  };
}

/**
 * One bounded page of profile Weekly Report history. The submission aggregate
 * is folded in with a LATERAL subquery, so the page costs one row-producing
 * statement no matter how many reports exist — never a query per report.
 * Tenant and owner scope are both enforced in SQL.
 */
const WEEKLY_REPORT_HISTORY_PAGE_SQL = `SELECT r.id AS report_id, r.job_card_id, r.staff_user_id,
    r.period_start, r.period_end, r.created_at, r.removed_at,
    j.status, j.due_date, j.manager_approved_at,
    COALESCE(agg.submission_count, 0)::int AS submission_count,
    agg.latest_seq_no, agg.latest_submitted_at
  FROM weekly_reports r
  JOIN job_cards j
    ON j.organization_id = r.organization_id AND j.id = r.job_card_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS submission_count,
           MAX(ws.seq_no) AS latest_seq_no,
           (ARRAY_AGG(ws.submitted_at ORDER BY ws.seq_no DESC))[1] AS latest_submitted_at
      FROM weekly_report_submissions ws
     WHERE ws.organization_id = r.organization_id AND ws.weekly_report_id = r.id
  ) agg ON TRUE
  WHERE r.organization_id = $1 AND r.staff_user_id = $2
  ORDER BY r.period_start DESC, (r.removed_at IS NOT NULL), r.created_at DESC, r.id
  LIMIT $3 OFFSET $4`;

export class PostgresWeeklyReportHistoryRepository implements WeeklyReportHistoryReadPort {
  constructor(private readonly pool: Pool) {}

  // The informational count and page are separate reads. They can observe
  // different snapshots if a report is created between the statements.
  async listForStaff(
    input: StaffWeeklyReportHistoryQuery,
  ): Promise<PaginatedWeeklyReportHistory> {
    // Defense in depth: a STAFF actor is scoped to its own reports in SQL even
    // if a caller resolves a different target id.
    const staffUserId = input.actor.role === 'STAFF' ? input.actor.id : input.targetUserId;
    const total = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM weekly_reports r
        WHERE r.organization_id = $1 AND r.staff_user_id = $2`,
      [input.organizationId, staffUserId],
    );
    const page = await this.pool.query<WeeklyReportHistoryRow>(
      WEEKLY_REPORT_HISTORY_PAGE_SQL,
      [input.organizationId, staffUserId, input.limit, input.offset],
    );
    return {
      items: page.rows.map(mapWeeklyReportHistoryItem),
      total: Number(total.rows[0]?.total ?? 0),
      limit: input.limit,
      offset: input.offset,
    };
  }
}
