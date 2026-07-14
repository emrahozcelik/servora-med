import type { Pool } from 'pg';

import type { StaffOperationalSummaryPort } from './ports.js';
import type {
  DashboardReportResponse,
  DeliveryDayItem,
  DeliveryProductItem,
  DeliveryPurposeItem,
  DeliveryReportReadInput,
  DeliveryReportResponse,
  DeliveryStaffItem,
  ReportStaffIdentity,
  ResolvedReportRange,
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

type DeliveryDayRow = {
  date: string;
  unit: string | null;
  quantity: string;
};

type DeliveryProductRow = {
  product_id: string;
  product_name_snapshot: string;
  product_sku_snapshot: string | null;
  product_model_snapshot: string | null;
  unit: string | null;
  quantity: string;
};

type DeliveryStaffRow = {
  staff_user_id: string;
  staff_name: string;
  is_active: boolean;
  unit: string | null;
  quantity: string;
};

type DeliveryGroupRow = DeliveryDayRow | DeliveryPurposeRow
  | DeliveryProductRow | DeliveryStaffRow;

type ResolvedReportRangeRow = {
  from: string;
  to: string;
  timezone: string;
};

type DeliveryGroupDefinition = {
  select: string;
  group: string;
  order: string;
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

const DELIVERY_GROUPS = {
  day: {
    select: `(di.delivered_at AT TIME ZONE organization_range.timezone)::date AS date,
  di.unit,
  to_char(SUM(di.quantity), 'FM999999999999999999990.000') AS quantity`,
    group: `(di.delivered_at AT TIME ZONE organization_range.timezone)::date, di.unit`,
    order: `date DESC, di.unit COLLATE "C" ASC NULLS LAST`,
  },
  purpose: {
    select: `di.delivery_purpose, di.unit,
  to_char(SUM(di.quantity), 'FM999999999999999999990.000') AS quantity`,
    group: `di.delivery_purpose, di.unit`,
    order: `CASE di.delivery_purpose
  WHEN 'SALE' THEN 1
  WHEN 'SAMPLE' THEN 2
  WHEN 'CONSIGNMENT' THEN 3
  WHEN 'RETURN' THEN 4
  WHEN 'OTHER' THEN 5
END,
di.unit COLLATE "C" ASC NULLS LAST`,
  },
  product: {
    select: `di.product_id, di.product_name_snapshot, di.product_sku_snapshot,
  di.product_model_snapshot, di.unit,
  to_char(SUM(di.quantity), 'FM999999999999999999990.000') AS quantity`,
    group: `di.product_id, di.product_name_snapshot, di.product_sku_snapshot,
  di.product_model_snapshot, di.unit`,
    order: `di.product_name_snapshot COLLATE "C" ASC, di.product_id ASC,
  di.product_sku_snapshot COLLATE "C" ASC NULLS LAST,
  di.product_model_snapshot COLLATE "C" ASC NULLS LAST,
  di.unit COLLATE "C" ASC NULLS LAST`,
  },
  staff: {
    select: `u.id AS staff_user_id, u.name AS staff_name, u.is_active,
  di.unit,
  to_char(SUM(di.quantity), 'FM999999999999999999990.000') AS quantity`,
    group: `u.id, u.name, u.is_active, di.unit`,
    order: `u.name COLLATE "C" ASC, u.id ASC,
  di.unit COLLATE "C" ASC NULLS LAST`,
  },
} as const satisfies Record<DeliveryReportReadInput['groupBy'], DeliveryGroupDefinition>;

const RESOLVED_REPORT_RANGE_SQL = `WITH ${ORGANIZATION_RANGE_CTE}
SELECT to_char(from_date, 'YYYY-MM-DD') AS "from",
  to_char(to_date, 'YYYY-MM-DD') AS "to",
  timezone
FROM organization_range`;

function deliveryGroupedSql(
  input: DeliveryReportReadInput,
  definition: DeliveryGroupDefinition,
) {
  const staffJoins = input.groupBy === 'staff'
    ? `
JOIN users u ON u.organization_id = jc.organization_id
  AND u.id = jc.assigned_to AND u.role = 'STAFF'
JOIN staff_profiles sp ON sp.organization_id = u.organization_id
  AND sp.user_id = u.id`
    : '';
  const staffFilter = input.staffUserId === null
    ? ''
    : '\n  AND jc.assigned_to = $5';

  return `WITH ${ORGANIZATION_RANGE_CTE}
SELECT ${definition.select}
FROM job_card_delivery_items di
JOIN job_cards jc ON jc.organization_id = di.organization_id
  AND jc.id = di.job_card_id${staffJoins}
CROSS JOIN organization_range
WHERE jc.organization_id = $1
  AND jc.type = 'PRODUCT_DELIVERY'
  AND jc.status = 'COMPLETED'
  AND jc.manager_approved_at IS NOT NULL
  AND di.delivered_at >=
    (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
  AND di.delivered_at <
    ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)${staffFilter}
GROUP BY ${definition.group}`;
}

function mapDeliveryGroup(
  groupBy: DeliveryReportReadInput['groupBy'],
  row: DeliveryGroupRow,
): DeliveryDayItem | DeliveryPurposeItem | DeliveryProductItem | DeliveryStaffItem {
  switch (groupBy) {
    case 'day': {
      const day = row as DeliveryDayRow;
      return { date: day.date, unit: day.unit, quantity: day.quantity };
    }
    case 'purpose': {
      const purpose = row as DeliveryPurposeRow;
      return {
        purpose: purpose.delivery_purpose,
        unit: purpose.unit,
        quantity: purpose.quantity,
      };
    }
    case 'product': {
      const product = row as DeliveryProductRow;
      return {
        productId: product.product_id,
        productNameSnapshot: product.product_name_snapshot,
        productSkuSnapshot: product.product_sku_snapshot,
        productModelSnapshot: product.product_model_snapshot,
        unit: product.unit,
        quantity: product.quantity,
      };
    }
    case 'staff': {
      const staff = row as DeliveryStaffRow;
      return {
        staff: {
          userId: staff.staff_user_id,
          name: staff.staff_name,
          isActive: staff.is_active,
        },
        unit: staff.unit,
        quantity: staff.quantity,
      };
    }
  }
}

function mapDeliveryItems(
  groupBy: DeliveryReportReadInput['groupBy'],
  rows: DeliveryGroupRow[],
) {
  return rows.map((row) => mapDeliveryGroup(groupBy, row));
}

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

  async getDeliveryReport(
    input: DeliveryReportReadInput,
  ): Promise<DeliveryReportResponse> {
    const definition = DELIVERY_GROUPS[input.groupBy];
    const rangeValues = [
      input.organizationId,
      input.requestedRange?.from ?? null,
      input.requestedRange?.to ?? null,
      input.requestTime,
    ];
    const groupedSql = deliveryGroupedSql(input, definition);
    const groupedValues = input.staffUserId === null
      ? rangeValues
      : [...rangeValues, input.staffUserId];
    const countSql = `SELECT COUNT(*)::int AS total FROM (${groupedSql}) grouped`;
    const limitParameter = groupedValues.length + 1;
    const offsetParameter = groupedValues.length + 2;
    const pageSql = `${groupedSql}
ORDER BY ${definition.order}
LIMIT $${limitParameter}
OFFSET $${offsetParameter}`;

    const rangeResult = await this.pool.query<ResolvedReportRangeRow>(
      RESOLVED_REPORT_RANGE_SQL,
      rangeValues,
    );
    const resolvedRange = rangeResult.rows[0];
    if (!resolvedRange) {
      throw new Error('Delivery report organization range could not be resolved.');
    }

    const [countResult, pageResult] = await Promise.all([
      this.pool.query<{ total: number }>(countSql, groupedValues),
      this.pool.query<DeliveryGroupRow>(
        pageSql,
        [...groupedValues, input.limit, input.offset],
      ),
    ]);
    const reportRange: ResolvedReportRange = resolvedRange;
    const common = {
      range: reportRange,
      total: countResult.rows[0]?.total ?? 0,
      limit: input.limit,
      offset: input.offset,
    };

    switch (input.groupBy) {
      case 'day':
        return {
          groupBy: 'day',
          items: mapDeliveryItems('day', pageResult.rows) as DeliveryDayItem[],
          ...common,
        };
      case 'purpose':
        return {
          groupBy: 'purpose',
          items: mapDeliveryItems('purpose', pageResult.rows) as DeliveryPurposeItem[],
          ...common,
        };
      case 'product':
        return {
          groupBy: 'product',
          items: mapDeliveryItems('product', pageResult.rows) as DeliveryProductItem[],
          ...common,
        };
      case 'staff':
        return {
          groupBy: 'staff',
          items: mapDeliveryItems('staff', pageResult.rows) as DeliveryStaffItem[],
          ...common,
        };
    }
  }
}
