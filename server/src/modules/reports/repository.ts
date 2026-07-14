import type { Pool } from 'pg';

import type { StaffOperationalSummaryPort } from './ports.js';
import type {
  StaffOperationalSummary,
  StaffOperationalSummaryManyInput,
  StaffOperationalSummaryOneInput,
} from './types.js';

type StaffSummaryRow = {
  staff_user_id: string;
  from_date: string;
  to_date: string;
  timezone: string;
  open_job_cards: string | number;
  waiting_approval: string | number;
  revision_requested: string | number;
  overdue_job_cards: string | number;
  completed_in_period: string | number;
};

const ORGANIZATION_RANGE_CTE = `organization_range AS (
  SELECT o.timezone,
    COALESCE($2::date,
      date_trunc('month', $4::timestamptz AT TIME ZONE o.timezone)::date) AS from_date,
    COALESCE($3::date,
      (date_trunc('month', $4::timestamptz AT TIME ZONE o.timezone)
        + interval '1 month - 1 day')::date) AS to_date
  FROM organizations o
  WHERE o.id = $1
)`;

const STAFF_SUMMARY_SQL = `WITH ${ORGANIZATION_RANGE_CTE}, requested AS (
  SELECT unnest($5::uuid[]) AS staff_user_id
)
SELECT requested.staff_user_id,
  to_char(organization_range.from_date, 'YYYY-MM-DD') AS from_date,
  to_char(organization_range.to_date, 'YYYY-MM-DD') AS to_date,
  organization_range.timezone,
  COUNT(jc.id) FILTER (
    WHERE jc.status IN ('NEW', 'PLANNED', 'IN_PROGRESS')
  )::int AS open_job_cards,
  COUNT(jc.id) FILTER (
    WHERE jc.status = 'WAITING_APPROVAL'
  )::int AS waiting_approval,
  COUNT(jc.id) FILTER (
    WHERE jc.status = 'REVISION_REQUESTED'
  )::int AS revision_requested,
  COUNT(jc.id) FILTER (
    WHERE jc.due_date <
      ($4::timestamptz AT TIME ZONE organization_range.timezone)::date
      AND jc.status IN (
        'NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'
      )
  )::int AS overdue_job_cards,
  COUNT(jc.id) FILTER (
    WHERE jc.status = 'COMPLETED'
      AND jc.manager_approved_at >=
        (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
      AND jc.manager_approved_at <
        ((organization_range.to_date + 1)::timestamp
          AT TIME ZONE organization_range.timezone)
  )::int AS completed_in_period
FROM requested
JOIN users u ON u.id = requested.staff_user_id
  AND u.organization_id = $1
  AND u.role = 'STAFF'
JOIN staff_profiles sp ON sp.organization_id = u.organization_id
  AND sp.user_id = u.id
CROSS JOIN organization_range
LEFT JOIN job_cards jc ON jc.organization_id = $1
  AND jc.assigned_to = requested.staff_user_id
GROUP BY requested.staff_user_id, organization_range.from_date,
  organization_range.to_date, organization_range.timezone
ORDER BY requested.staff_user_id`;

function mapStaffSummary(row: StaffSummaryRow): StaffOperationalSummary {
  return {
    staffUserId: row.staff_user_id,
    range: {
      from: row.from_date,
      to: row.to_date,
      timezone: row.timezone,
    },
    counters: {
      openJobCards: Number(row.open_job_cards),
      waitingApproval: Number(row.waiting_approval),
      revisionRequested: Number(row.revision_requested),
      overdueJobCards: Number(row.overdue_job_cards),
      completedInPeriod: Number(row.completed_in_period),
    },
  };
}

export class PostgresReportsRepository implements StaffOperationalSummaryPort {
  constructor(private readonly pool: Pool) {}

  async getOne(input: StaffOperationalSummaryOneInput) {
    const summaries = await this.getMany({
      organizationId: input.organizationId,
      staffUserIds: [input.staffUserId],
      requestedRange: input.requestedRange,
      requestTime: input.requestTime,
    });
    return summaries.get(input.staffUserId) ?? null;
  }

  async getMany(input: StaffOperationalSummaryManyInput) {
    const staffUserIds = [...new Set(input.staffUserIds)];
    if (staffUserIds.length === 0) {
      return new Map<string, StaffOperationalSummary>();
    }
    const result = await this.pool.query<StaffSummaryRow>(STAFF_SUMMARY_SQL, [
      input.organizationId,
      input.requestedRange?.from ?? null,
      input.requestedRange?.to ?? null,
      input.requestTime,
      staffUserIds,
    ]);
    return new Map(result.rows.map((row) => [row.staff_user_id, mapStaffSummary(row)]));
  }
}
