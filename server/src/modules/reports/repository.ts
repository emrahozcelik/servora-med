import type { Pool } from 'pg';

import type { StaffOperationalSummaryPort } from './ports.js';
import type {
  DashboardReportResponse,
  DeliveryPurposeItem,
  ReportStaffIdentity,
  StaffOperationalSummary,
  StaffOperationalSummaryManyInput,
  StaffOperationalSummaryOneInput,
  StaffOperationalSummaryScope,
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

type DashboardRow = {
  from_date: string;
  to_date: string;
  timezone: string;
  active_job_cards: string | number;
  overdue_job_cards: string | number;
  waiting_approval: string | number;
  revision_requested: string | number;
  completed_in_period: string | number;
  cancelled_in_period: string | number;
  completed_trend: Array<{ date: string; count: string | number }>;
};

type StaffIdentityRow = {
  id: string;
  name: string;
  is_active: boolean;
};

type DeliveryPurposeRow = {
  delivery_purpose: DeliveryPurposeItem['purpose'];
  unit: string | null;
  quantity: string;
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

const DASHBOARD_SQL = `WITH ${ORGANIZATION_RANGE_CTE}, counters AS (
  SELECT
    COUNT(jc.id) FILTER (
      WHERE jc.status IN (
        'NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'
      )
    )::int AS active_job_cards,
    COUNT(jc.id) FILTER (
      WHERE jc.due_date <
        ($4::timestamptz AT TIME ZONE organization_range.timezone)::date
        AND jc.status IN (
          'NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'
        )
    )::int AS overdue_job_cards,
    COUNT(jc.id) FILTER (
      WHERE jc.status = 'WAITING_APPROVAL'
    )::int AS waiting_approval,
    COUNT(jc.id) FILTER (
      WHERE jc.status = 'REVISION_REQUESTED'
    )::int AS revision_requested,
    COUNT(jc.id) FILTER (
      WHERE jc.status = 'COMPLETED'
        AND jc.manager_approved_at >=
          (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
        AND jc.manager_approved_at <
          ((organization_range.to_date + 1)::timestamp
            AT TIME ZONE organization_range.timezone)
    )::int AS completed_in_period,
    COUNT(jc.id) FILTER (
      WHERE jc.status = 'CANCELLED'
        AND jc.cancelled_at >=
          (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
        AND jc.cancelled_at <
          ((organization_range.to_date + 1)::timestamp
            AT TIME ZONE organization_range.timezone)
    )::int AS cancelled_in_period
  FROM job_cards jc
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
), days AS (
  SELECT day::date
  FROM organization_range,
    generate_series(
      organization_range.from_date,
      organization_range.to_date,
      interval '1 day'
    ) day
), trend AS (
  SELECT days.day,
    COUNT(jc.id) FILTER (WHERE jc.status = 'COMPLETED')::int AS count
  FROM days
  CROSS JOIN organization_range
  LEFT JOIN job_cards jc ON jc.organization_id = $1
    AND jc.manager_approved_at >=
      (days.day::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.manager_approved_at <
      ((days.day + 1)::timestamp AT TIME ZONE organization_range.timezone)
  GROUP BY days.day
  ORDER BY days.day
)
SELECT to_char(organization_range.from_date, 'YYYY-MM-DD') AS from_date,
  to_char(organization_range.to_date, 'YYYY-MM-DD') AS to_date,
  organization_range.timezone,
  counters.active_job_cards, counters.overdue_job_cards,
  counters.waiting_approval, counters.revision_requested,
  counters.completed_in_period, counters.cancelled_in_period,
  COALESCE(
    json_agg(json_build_object(
      'date', to_char(trend.day, 'YYYY-MM-DD'),
      'count', trend.count
    ) ORDER BY trend.day),
    '[]'::json
  ) AS completed_trend
FROM organization_range
CROSS JOIN counters
CROSS JOIN trend
GROUP BY organization_range.from_date, organization_range.to_date,
  organization_range.timezone, counters.active_job_cards,
  counters.overdue_job_cards, counters.waiting_approval,
  counters.revision_requested, counters.completed_in_period,
  counters.cancelled_in_period`;

const STAFF_IDENTITY_SQL = `SELECT u.id, u.name, u.is_active
FROM users u
JOIN staff_profiles sp
  ON sp.organization_id = u.organization_id AND sp.user_id = u.id
WHERE u.organization_id = $1 AND u.id = $2 AND u.role = 'STAFF'
LIMIT 1`;

const STAFF_DELIVERIES_BY_PURPOSE_SQL = `WITH organization_range AS (
  SELECT o.timezone,
    COALESCE($3::date,
      date_trunc('month', $5::timestamptz AT TIME ZONE o.timezone)::date) AS from_date,
    COALESCE($4::date,
      (date_trunc('month', $5::timestamptz AT TIME ZONE o.timezone)
        + interval '1 month - 1 day')::date) AS to_date
  FROM organizations o
  WHERE o.id = $1
)
SELECT di.delivery_purpose, di.unit,
  to_char(SUM(di.quantity), 'FM999999999999999999990.000') AS quantity
FROM job_card_delivery_items di
JOIN job_cards jc ON jc.organization_id = di.organization_id
  AND jc.id = di.job_card_id
CROSS JOIN organization_range
WHERE jc.organization_id = $1
  AND jc.assigned_to = $2
  AND jc.type = 'PRODUCT_DELIVERY'
  AND jc.status = 'COMPLETED'
  AND jc.manager_approved_at IS NOT NULL
  AND di.delivered_at >=
    (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
  AND di.delivered_at <
    ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
GROUP BY di.delivery_purpose, di.unit
ORDER BY CASE di.delivery_purpose
  WHEN 'SALE' THEN 1
  WHEN 'SAMPLE' THEN 2
  WHEN 'CONSIGNMENT' THEN 3
  WHEN 'RETURN' THEN 4
  WHEN 'OTHER' THEN 5
END,
di.unit COLLATE "C" ASC NULLS LAST`;

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

function mapDashboard(row: DashboardRow): DashboardReportResponse {
  return {
    range: {
      from: row.from_date,
      to: row.to_date,
      timezone: row.timezone,
    },
    counters: {
      activeJobCards: Number(row.active_job_cards),
      overdueJobCards: Number(row.overdue_job_cards),
      waitingApproval: Number(row.waiting_approval),
      revisionRequested: Number(row.revision_requested),
      completedInPeriod: Number(row.completed_in_period),
      cancelledInPeriod: Number(row.cancelled_in_period),
    },
    completedTrend: row.completed_trend.map((point) => ({
      date: point.date,
      count: Number(point.count),
    })),
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

  async getDashboard(input: StaffOperationalSummaryScope) {
    const result = await this.pool.query<DashboardRow>(DASHBOARD_SQL, [
      input.organizationId,
      input.requestedRange?.from ?? null,
      input.requestedRange?.to ?? null,
      input.requestTime,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error('Dashboard organization range could not be resolved.');
    return mapDashboard(row);
  }

  async getStaffIdentity(input: {
    organizationId: string;
    staffUserId: string;
  }): Promise<ReportStaffIdentity | null> {
    const result = await this.pool.query<StaffIdentityRow>(STAFF_IDENTITY_SQL, [
      input.organizationId,
      input.staffUserId,
    ]);
    const row = result.rows[0];
    return row
      ? { userId: row.id, name: row.name, isActive: row.is_active }
      : null;
  }

  async getStaffDeliveriesByPurpose(
    input: StaffOperationalSummaryOneInput,
  ): Promise<DeliveryPurposeItem[]> {
    const result = await this.pool.query<DeliveryPurposeRow>(
      STAFF_DELIVERIES_BY_PURPOSE_SQL,
      [
        input.organizationId,
        input.staffUserId,
        input.requestedRange?.from ?? null,
        input.requestedRange?.to ?? null,
        input.requestTime,
      ],
    );
    return result.rows.map((row) => ({
      purpose: row.delivery_purpose,
      unit: row.unit,
      quantity: row.quantity,
    }));
  }
}
