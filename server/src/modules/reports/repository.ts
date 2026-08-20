import type { Pool } from 'pg';

import {
  ACTIVE_JOB_CARD_STATUSES,
  JOB_CARD_TYPES,
  type FollowUpProposalOrigin,
  type JobCardStatus,
  type JobCardType,
} from '../job-cards/types.js';
import type { ReportsReadModel } from './ports.js';
import type {
  ApprovalSummary,
  CustomerReportActivity,
  CustomerReportItem,
  CustomerReportReadInput,
  CustomerReportResponse,
  CustomerReportUnassigned,
  DashboardReportResponse,
  DeliveryDayItem,
  DeliveryProductItem,
  DeliveryPurposeItem,
  DeliveryReportReadInput,
  DeliveryReportResponse,
  DeliveryStaffItem,
  MeetingOutcomeItem,
  ProposalQueueItem,
  ReportStaffLifecycleIdentity,
  ResolvedReportRange,
  SalesFollowUpReportReadInput,
  SalesFollowUpReportResponse,
  SalesFollowUpStatusDistributionItem,
  SalesFollowUpTypeDistributionItem,
  StaffCompletionPerformance,
  StaffExecutionAggregate,
  StaffOnTimeAggregate,
  StaffOperationalSummary,
  StaffOperationalSummaryManyInput,
  StaffOperationalSummaryOneInput,
  StaffOperationalSummaryScope,
  StaffPerformanceScope,
  StaffPerformanceScopeInput,
  WorkTypeDistributionInput,
  WorkTypeDistributionItem,
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
  current_workload_by_type?: Array<{ type: string; count: string | number }>;
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
  daily_created_trend: Array<{ date: string; count: string | number }>;
  active_status_distribution: Array<{ status: JobCardStatus; count: string | number }>;
  created_work_type_distribution: Array<{ type: string; count: string | number }>;
};

type StaffIdentityRow = {
  id: string;
  name: string;
  is_active: boolean;
  created_at: Date;
};

type StaffPerformanceScopeRow = {
  from_date: string;
  to_date: string;
  timezone: string;
  staff: ReportStaffLifecycleIdentity[];
};

type StaffCompletionPerformanceRow = {
  staff_user_id: string;
  completion_days: string | number;
  completion_work_types: Array<{ type: string; count: string | number }>;
};

type StaffExecutionRow = {
  staff_user_id: string;
  staff_completed_jobs: string | number;
  staff_completion_days: string | number;
  missing_staff_completion_timestamp: string | number;
  recorded_submission_count: string | number;
  recorded_submission_days: string | number;
};

type StaffOnTimeRow = {
  staff_user_id: string;
  eligible_scheduled_completed_jobs: string | number;
  on_time_completed_jobs: string | number;
  late_completed_jobs: string | number;
  ineligible_or_no_deadline_completed_jobs: string | number;
};

type StaffCountRow = {
  staff_user_id: string;
  count: string | number;
};

type DailyCompletionRow = {
  date: string;
  count: string | number;
};

type DeliveryPurposeRow = {
  delivery_purpose: DeliveryPurposeItem['purpose'];
  unit: string | null;
  quantity: string;
};

type MeetingOutcomeRow = {
  outcome: MeetingOutcomeItem['outcome'];
  count: string | number;
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

type ApprovalSummaryRow = {
  pending_count: string | number;
  oldest_waiting_minutes: string | number | null;
  average_waiting_minutes: string | number | null;
  under_2_hours: string | number;
  between_2_and_8_hours: string | number;
  between_8_and_24_hours: string | number;
  over_24_hours: string | number;
};

type CustomerReportRow = {
  id: string;
  name: string;
  customer_type: string;
  status: string;
  active: string | number;
  actionable: string | number;
  waiting_approval: string | number;
  revision_requested: string | number;
  overdue: string | number;
  created: string | number;
  created_product_delivery: string | number;
  created_general_task: string | number;
  created_sales_meeting: string | number;
  manager_approved: string | number;
  follow_up_children: string | number;
};

type CustomerReportUnassignedRow = Omit<CustomerReportRow, 'id' | 'name' | 'customer_type' | 'status'>;

type SalesFollowUpAggregateRow = {
  from_date: string;
  to_date: string;
  timezone: string;
  current_sales_meetings_total: string | number;
  proposal_queue_total: string | number;
  active_children_total: string | number;
  overdue_due_dated_follow_up_children: string | number;
  sales_meetings_created: string | number;
  sales_meetings_manager_approved: string | number;
  follow_up_children_created: string | number;
  direct_follow_up_links: string | number;
  current_customer_divergence: string | number;
  sales_meeting_status_distribution: Array<{ status: JobCardStatus; count: string | number }>;
  child_status_distribution: Array<{ status: JobCardStatus; count: string | number }>;
  child_type_distribution: Array<{ type: JobCardType; count: string | number }>;
  children_created_by_type: Array<{ type: JobCardType; count: string | number }>;
  outcome_distribution: Array<{ outcome: MeetingOutcomeItem['outcome']; count: string | number }>;
};

type SalesMeetingQueueRow = {
  id: string;
  status: JobCardStatus;
  scheduled_at: Date | null;
  customer_id: string | null;
  customer_name: string | null;
  assignee_id: string;
  assignee_name: string;
};

type ProposalQueueRow = {
  id: string;
  status: JobCardStatus;
  follow_up_proposed_at: Date | null;
  follow_up_proposed_type: JobCardType | null;
  follow_up_proposal_instructions: string | null;
  follow_up_proposal_origin: FollowUpProposalOrigin | null;
  customer_id: string | null;
  customer_name: string | null;
  assignee_id: string;
  assignee_name: string;
  proposed_assignee_id: string | null;
  proposed_assignee_name: string | null;
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

/**
 * Canonical overdue predicate: due_date strictly before the organization-local
 * current date, independent of scheduled_at. `$4` is the requestTime instant.
 */
const OVERDUE_JOB_CARD_CLAUSE = `jc.due_date IS NOT NULL
  AND jc.due_date < ($4::timestamptz AT TIME ZONE organization_range.timezone)::date`;

const ACTIVE_STATUS_LIST_SQL = ACTIVE_JOB_CARD_STATUSES.map((status) => `'${status}'`).join(', ');
const ACTIVE_STATUS_BUCKETS_SQL = ACTIVE_JOB_CARD_STATUSES
  .map((status, index) => `('${status}', ${index + 1})`)
  .join(',\n    ');
const WORK_TYPE_BUCKETS_SQL = JOB_CARD_TYPES
  .map((type, index) => `('${type}', ${index + 1})`)
  .join(',\n    ');

const STAFF_SUMMARY_SQL = `WITH ${ORGANIZATION_RANGE_CTE}, requested AS (
  SELECT unnest($5::uuid[]) AS staff_user_id
), work_types(type, sort_order) AS (
  VALUES ${WORK_TYPE_BUCKETS_SQL}
)
SELECT requested.staff_user_id,
  to_char(organization_range.from_date, 'YYYY-MM-DD') AS from_date,
  to_char(organization_range.to_date, 'YYYY-MM-DD') AS to_date,
  organization_range.timezone,
  COUNT(jc.id) FILTER (
    WHERE jc.status IN ('NEW', 'ACCEPTED', 'IN_PROGRESS')
  )::int AS open_job_cards,
  COUNT(jc.id) FILTER (
    WHERE jc.status = 'WAITING_APPROVAL'
  )::int AS waiting_approval,
  COUNT(jc.id) FILTER (
    WHERE jc.status = 'REVISION_REQUESTED'
  )::int AS revision_requested,
  COUNT(jc.id) FILTER (
    WHERE jc.status IN (
        ${ACTIVE_STATUS_LIST_SQL}
      )
      AND (
        ${OVERDUE_JOB_CARD_CLAUSE}
      )
  )::int AS overdue_job_cards,
  COUNT(jc.id) FILTER (
    WHERE jc.status = 'COMPLETED'
      AND jc.manager_approved_at >=
        (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
      AND jc.manager_approved_at <
        ((organization_range.to_date + 1)::timestamp
          AT TIME ZONE organization_range.timezone)
  )::int AS completed_in_period,
  COALESCE((
    SELECT json_agg(json_build_object(
      'type', workload.type,
      'count', workload.count
    ) ORDER BY workload.sort_order)
    FROM (
      SELECT work_types.type, work_types.sort_order,
        COUNT(typed_job.id) FILTER (
          WHERE typed_job.status IN (${ACTIVE_STATUS_LIST_SQL})
        )::int AS count
      FROM work_types
      LEFT JOIN job_cards typed_job ON typed_job.organization_id = $1
        AND typed_job.assigned_to = requested.staff_user_id
        AND typed_job.type = work_types.type
      GROUP BY work_types.type, work_types.sort_order
    ) workload
  ), '[]'::json) AS current_workload_by_type
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
      WHERE jc.status IN (${ACTIVE_STATUS_LIST_SQL})
    )::int AS active_job_cards,
    COUNT(jc.id) FILTER (
      WHERE jc.status IN (${ACTIVE_STATUS_LIST_SQL})
        AND (
          ${OVERDUE_JOB_CARD_CLAUSE}
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
), created_trend AS (
  SELECT days.day,
    COUNT(jc.id)::int AS count
  FROM days
  CROSS JOIN organization_range
  LEFT JOIN job_cards jc ON jc.organization_id = $1
    AND jc.created_at >=
      (days.day::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.created_at <
      ((days.day + 1)::timestamp AT TIME ZONE organization_range.timezone)
  GROUP BY days.day
  ORDER BY days.day
), active_statuses(status, sort_order) AS (
  VALUES ${ACTIVE_STATUS_BUCKETS_SQL}
), active_status_distribution AS (
  SELECT active_statuses.status, active_statuses.sort_order,
    COUNT(jc.id)::int AS count
  FROM active_statuses
  CROSS JOIN organization_range
  LEFT JOIN job_cards jc ON jc.organization_id = $1
    AND jc.status = active_statuses.status
  GROUP BY active_statuses.status, active_statuses.sort_order
), work_types(type, sort_order) AS (
  VALUES ${WORK_TYPE_BUCKETS_SQL}
), created_work_type_distribution AS (
  SELECT work_types.type, work_types.sort_order,
    COUNT(jc.id)::int AS count
  FROM work_types
  CROSS JOIN organization_range
  LEFT JOIN job_cards jc ON jc.organization_id = $1
    AND jc.type = work_types.type
    AND jc.created_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.created_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
  GROUP BY work_types.type, work_types.sort_order
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
  ) AS completed_trend,
  COALESCE(
    (SELECT json_agg(json_build_object(
      'date', to_char(created_trend.day, 'YYYY-MM-DD'),
      'count', created_trend.count
    ) ORDER BY created_trend.day) FROM created_trend),
    '[]'::json
  ) AS daily_created_trend,
  COALESCE(
    (SELECT json_agg(json_build_object(
      'status', active_status_distribution.status,
      'count', active_status_distribution.count
    ) ORDER BY active_status_distribution.sort_order)
     FROM active_status_distribution),
    '[]'::json
  ) AS active_status_distribution,
  COALESCE(
    (SELECT json_agg(json_build_object(
      'type', created_work_type_distribution.type,
      'count', created_work_type_distribution.count
    ) ORDER BY created_work_type_distribution.sort_order)
     FROM created_work_type_distribution),
    '[]'::json
  ) AS created_work_type_distribution
FROM organization_range
CROSS JOIN counters
CROSS JOIN trend
GROUP BY organization_range.from_date, organization_range.to_date,
  organization_range.timezone, counters.active_job_cards,
  counters.overdue_job_cards, counters.waiting_approval,
  counters.revision_requested, counters.completed_in_period,
  counters.cancelled_in_period`;

const STAFF_IDENTITY_SQL = `SELECT u.id, u.name, u.is_active, u.created_at
FROM users u
JOIN staff_profiles sp
  ON sp.organization_id = u.organization_id AND sp.user_id = u.id
WHERE u.organization_id = $1 AND u.id = $2 AND u.role = 'STAFF'
LIMIT 1`;

const STAFF_PERFORMANCE_SCOPE_SQL = `WITH ${ORGANIZATION_RANGE_CTE}, staff_scope AS (
  SELECT u.id, u.name, u.is_active, u.created_at
  FROM users u
  JOIN staff_profiles sp ON sp.organization_id = u.organization_id
    AND sp.user_id = u.id
  WHERE u.organization_id = $1
    AND u.role = 'STAFF'
    AND ($5::boolean OR u.is_active)
)
SELECT to_char(organization_range.from_date, 'YYYY-MM-DD') AS from_date,
  to_char(organization_range.to_date, 'YYYY-MM-DD') AS to_date,
  organization_range.timezone,
  COALESCE(
    json_agg(
      json_build_object(
        'userId', staff_scope.id,
        'name', staff_scope.name,
        'isActive', staff_scope.is_active,
        'createdAt', staff_scope.created_at
      ) ORDER BY staff_scope.name COLLATE "C", staff_scope.id
    ) FILTER (WHERE staff_scope.id IS NOT NULL),
    '[]'::json
  ) AS staff
FROM organization_range
LEFT JOIN staff_scope ON TRUE
GROUP BY organization_range.from_date, organization_range.to_date,
  organization_range.timezone`;

const STAFF_COMPLETION_PERFORMANCE_SQL = `WITH ${ORGANIZATION_RANGE_CTE}, requested AS (
  SELECT unnest($5::uuid[]) AS staff_user_id
), completed AS (
  SELECT jc.assigned_to AS staff_user_id,
    (jc.manager_approved_at AT TIME ZONE organization_range.timezone)::date
      AS completion_date,
    jc.type
  FROM job_cards jc
  JOIN requested ON requested.staff_user_id = jc.assigned_to
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.status = 'COMPLETED'
    AND jc.manager_approved_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.manager_approved_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
), completion_days AS (
  SELECT staff_user_id, COUNT(DISTINCT completion_date)::int AS completion_days
  FROM completed
  GROUP BY staff_user_id
), work_types(type, sort_order) AS (
  VALUES ${WORK_TYPE_BUCKETS_SQL}
), work_type_counts AS (
  SELECT requested.staff_user_id, work_types.type, work_types.sort_order,
    COUNT(completed.staff_user_id)::int AS count
  FROM requested
  CROSS JOIN work_types
  LEFT JOIN completed ON completed.staff_user_id = requested.staff_user_id
    AND completed.type = work_types.type
  GROUP BY requested.staff_user_id, work_types.type, work_types.sort_order
), work_type_lists AS (
  SELECT staff_user_id,
    json_agg(
      json_build_object('type', type, 'count', count)
      ORDER BY sort_order
    ) AS completion_work_types
  FROM work_type_counts
  GROUP BY staff_user_id
)
SELECT requested.staff_user_id,
  COALESCE(completion_days.completion_days, 0)::int AS completion_days,
  COALESCE(work_type_lists.completion_work_types, '[]'::json)
    AS completion_work_types
FROM requested
LEFT JOIN completion_days USING (staff_user_id)
LEFT JOIN work_type_lists USING (staff_user_id)
ORDER BY requested.staff_user_id`;

const STAFF_EXECUTION_SQL = `WITH ${ORGANIZATION_RANGE_CTE}, requested AS (
  SELECT unnest($5::uuid[]) AS staff_user_id
), executed AS (
  SELECT jc.assigned_to AS staff_user_id,
    jc.staff_completed_at,
    (jc.staff_completed_at AT TIME ZONE organization_range.timezone)::date
      AS staff_completion_date
  FROM job_cards jc
  JOIN requested ON requested.staff_user_id = jc.assigned_to
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.status = 'COMPLETED'
    AND jc.staff_completed_at IS NOT NULL
    AND jc.staff_completed_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.staff_completed_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
), approved_missing AS (
  SELECT jc.assigned_to AS staff_user_id
  FROM job_cards jc
  JOIN requested ON requested.staff_user_id = jc.assigned_to
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.status = 'COMPLETED'
    AND jc.staff_completed_at IS NULL
    AND jc.manager_approved_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.manager_approved_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
), recorded_submissions AS (
  SELECT jc.staff_completed_by AS staff_user_id,
    (jc.staff_completed_at AT TIME ZONE organization_range.timezone)::date
      AS recorded_submission_date
  FROM job_cards jc
  JOIN requested ON requested.staff_user_id = jc.staff_completed_by
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.staff_completed_at IS NOT NULL
    AND jc.staff_completed_by IS NOT NULL
    AND jc.staff_completed_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.staff_completed_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
), executed_counts AS (
  SELECT staff_user_id,
    COUNT(*)::int AS staff_completed_jobs,
    COUNT(DISTINCT staff_completion_date)::int AS staff_completion_days
  FROM executed
  GROUP BY staff_user_id
), approved_missing_counts AS (
  SELECT staff_user_id,
    COUNT(*)::int AS missing_staff_completion_timestamp
  FROM approved_missing
  GROUP BY staff_user_id
), recorded_submission_counts AS (
  SELECT staff_user_id,
    COUNT(*)::int AS recorded_submission_count,
    COUNT(DISTINCT recorded_submission_date)::int AS recorded_submission_days
  FROM recorded_submissions
  GROUP BY staff_user_id
)
SELECT requested.staff_user_id,
  COALESCE(executed_counts.staff_completed_jobs, 0)::int AS staff_completed_jobs,
  COALESCE(executed_counts.staff_completion_days, 0)::int AS staff_completion_days,
  COALESCE(approved_missing_counts.missing_staff_completion_timestamp, 0)::int
    AS missing_staff_completion_timestamp,
  COALESCE(recorded_submission_counts.recorded_submission_count, 0)::int
    AS recorded_submission_count,
  COALESCE(recorded_submission_counts.recorded_submission_days, 0)::int
    AS recorded_submission_days
FROM requested
LEFT JOIN executed_counts USING (staff_user_id)
LEFT JOIN approved_missing_counts USING (staff_user_id)
LEFT JOIN recorded_submission_counts USING (staff_user_id)
ORDER BY requested.staff_user_id`;

const STAFF_ON_TIME_SQL = `WITH ${ORGANIZATION_RANGE_CTE}, requested AS (
  SELECT unnest($5::uuid[]) AS staff_user_id
), completed AS (
  SELECT jc.assigned_to AS staff_user_id, jc.type, jc.staff_completed_at,
    jc.scheduled_at, jc.scheduled_ends_at,
    CASE
      WHEN jc.scheduled_ends_at IS NOT NULL THEN jc.scheduled_ends_at
      WHEN jc.type = 'SALES_MEETING' THEN NULL
      ELSE jc.scheduled_at
    END AS effective_deadline_at
  FROM job_cards jc
  JOIN requested ON requested.staff_user_id = jc.assigned_to
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.status = 'COMPLETED'
    AND jc.manager_approved_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.manager_approved_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
)
SELECT requested.staff_user_id,
  COUNT(completed.staff_user_id) FILTER (
    WHERE completed.effective_deadline_at IS NOT NULL
      AND completed.staff_completed_at IS NOT NULL
  )::int AS eligible_scheduled_completed_jobs,
  COUNT(completed.staff_user_id) FILTER (
    WHERE completed.effective_deadline_at IS NOT NULL
      AND completed.staff_completed_at IS NOT NULL
      AND completed.staff_completed_at <= completed.effective_deadline_at
  )::int AS on_time_completed_jobs,
  COUNT(completed.staff_user_id) FILTER (
    WHERE completed.effective_deadline_at IS NOT NULL
      AND completed.staff_completed_at IS NOT NULL
      AND completed.staff_completed_at > completed.effective_deadline_at
  )::int AS late_completed_jobs,
  COUNT(completed.staff_user_id) FILTER (
    WHERE completed.effective_deadline_at IS NULL
      OR completed.staff_completed_at IS NULL
  )::int AS ineligible_or_no_deadline_completed_jobs
FROM requested
LEFT JOIN completed USING (staff_user_id)
GROUP BY requested.staff_user_id
ORDER BY requested.staff_user_id`;

const STAFF_CORRECTION_EVENTS_SQL = `WITH ${ORGANIZATION_RANGE_CTE}, requested AS (
  SELECT unnest($5::uuid[]) AS staff_user_id
)
SELECT requested.staff_user_id, COUNT(activity.id)::int AS count
FROM requested
JOIN job_cards jc ON jc.organization_id = $1
  AND jc.assigned_to = requested.staff_user_id
JOIN job_card_activity_logs activity ON activity.organization_id = jc.organization_id
  AND activity.job_card_id = jc.id
CROSS JOIN organization_range
WHERE activity.event_type = 'JOB_REVISION_REQUESTED'
  AND activity.created_at >=
    (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
  AND activity.created_at <
    ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
GROUP BY requested.staff_user_id
ORDER BY requested.staff_user_id`;

const STAFF_AUTHORED_OPERATIONAL_NOTES_SQL = `WITH ${ORGANIZATION_RANGE_CTE}, requested AS (
  SELECT unnest($5::uuid[]) AS staff_user_id
)
SELECT requested.staff_user_id, COUNT(n.id)::int AS count
FROM requested
JOIN job_card_notes n ON n.organization_id = $1
  AND n.author_id = requested.staff_user_id
CROSS JOIN organization_range
WHERE (n.record_version = 0 OR n.context = 'GENERAL')
  AND n.created_at >=
    (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
  AND n.created_at <
    ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
GROUP BY requested.staff_user_id
ORDER BY requested.staff_user_id`;

const STAFF_DAILY_COMPLETION_TREND_SQL = `WITH organization_range AS (
  SELECT o.timezone,
    COALESCE($3::date,
      date_trunc('month', $5::timestamptz AT TIME ZONE o.timezone)::date) AS from_date,
    COALESCE($4::date,
      (date_trunc('month', $5::timestamptz AT TIME ZONE o.timezone)
        + interval '1 month - 1 day')::date) AS to_date
  FROM organizations o
  WHERE o.id = $1
), days AS (
  SELECT day::date
  FROM organization_range,
    generate_series(
      organization_range.from_date,
      organization_range.to_date,
      interval '1 day'
    ) day
)
SELECT to_char(days.day, 'YYYY-MM-DD') AS date,
  COUNT(jc.id)::int AS count
FROM days
CROSS JOIN organization_range
LEFT JOIN job_cards jc ON jc.organization_id = $1
  AND jc.assigned_to = $2
  AND jc.status = 'COMPLETED'
  AND jc.manager_approved_at >=
    (days.day::timestamp AT TIME ZONE organization_range.timezone)
  AND jc.manager_approved_at <
    ((days.day + 1)::timestamp AT TIME ZONE organization_range.timezone)
GROUP BY days.day
ORDER BY days.day`;

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

const STAFF_MEETINGS_BY_OUTCOME_SQL = `WITH organization_range AS (
  SELECT o.timezone,
    COALESCE($3::date,
      date_trunc('month', $5::timestamptz AT TIME ZONE o.timezone)::date) AS from_date,
    COALESCE($4::date,
      (date_trunc('month', $5::timestamptz AT TIME ZONE o.timezone)
        + interval '1 month - 1 day')::date) AS to_date
  FROM organizations o
  WHERE o.id = $1
), outcomes(outcome, sort_order) AS (
  VALUES
    ('POSITIVE', 1),
    ('FOLLOW_UP_REQUIRED', 2),
    ('NO_DECISION', 3),
    ('NOT_INTERESTED', 4)
), outcome_counts AS (
  SELECT md.outcome, COUNT(*)::int AS count
  FROM job_card_meeting_details md
  JOIN job_cards jc ON jc.organization_id = md.organization_id
    AND jc.id = md.job_card_id
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.assigned_to = $2
    AND jc.type = 'SALES_MEETING'
    AND jc.status = 'COMPLETED'
    AND md.meeting_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND md.meeting_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
  GROUP BY md.outcome
)
SELECT outcomes.outcome, COALESCE(outcome_counts.count, 0)::int AS count
FROM outcomes
LEFT JOIN outcome_counts ON outcome_counts.outcome = outcomes.outcome
ORDER BY outcomes.sort_order`;

const DELIVERY_GROUPS = {
  day: {
    select: `to_char(
    (di.delivered_at AT TIME ZONE organization_range.timezone)::date,
    'YYYY-MM-DD'
  ) AS date,
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

const APPROVAL_SUMMARY_SQL = `WITH waiting AS (
  SELECT GREATEST($2::timestamptz - j.staff_completed_at,
    interval '0 seconds') AS elapsed
  FROM job_cards j
  WHERE j.organization_id = $1 AND j.status = 'WAITING_APPROVAL'
)
SELECT COUNT(*)::int AS pending_count,
  FLOOR(EXTRACT(EPOCH FROM MAX(elapsed)) / 60)::int AS oldest_waiting_minutes,
  ROUND(AVG(EXTRACT(EPOCH FROM elapsed)) / 60)::int AS average_waiting_minutes,
  COUNT(*) FILTER (WHERE elapsed < interval '2 hours')::int AS under_2_hours,
  COUNT(*) FILTER (WHERE elapsed >= interval '2 hours'
    AND elapsed < interval '8 hours')::int AS between_2_and_8_hours,
  COUNT(*) FILTER (WHERE elapsed >= interval '8 hours'
    AND elapsed < interval '24 hours')::int AS between_8_and_24_hours,
  COUNT(*) FILTER (WHERE elapsed >= interval '24 hours')::int AS over_24_hours
FROM waiting`;

const CUSTOMER_REPORT_ACTIVITY_COLUMNS = `
    COUNT(jc.id) FILTER (
      WHERE jc.status IN (${ACTIVE_STATUS_LIST_SQL})
    )::int AS active,
    COUNT(jc.id) FILTER (
      WHERE jc.status IN ('NEW', 'ACCEPTED', 'IN_PROGRESS')
    )::int AS actionable,
    COUNT(jc.id) FILTER (
      WHERE jc.status = 'WAITING_APPROVAL'
    )::int AS waiting_approval,
    COUNT(jc.id) FILTER (
      WHERE jc.status = 'REVISION_REQUESTED'
    )::int AS revision_requested,
    COUNT(jc.id) FILTER (
      WHERE jc.status IN (${ACTIVE_STATUS_LIST_SQL})
        AND jc.due_date IS NOT NULL
        AND jc.due_date < ($4::timestamptz AT TIME ZONE organization_range.timezone)::date
    )::int AS overdue,
    COUNT(jc.id) FILTER (
      WHERE jc.created_at >=
        (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
        AND jc.created_at <
        ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
    )::int AS created,
    COUNT(jc.id) FILTER (
      WHERE jc.created_at >=
        (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
        AND jc.created_at <
        ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
        AND jc.type = 'PRODUCT_DELIVERY'
    )::int AS created_product_delivery,
    COUNT(jc.id) FILTER (
      WHERE jc.created_at >=
        (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
        AND jc.created_at <
        ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
        AND jc.type = 'GENERAL_TASK'
    )::int AS created_general_task,
    COUNT(jc.id) FILTER (
      WHERE jc.created_at >=
        (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
        AND jc.created_at <
        ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
        AND jc.type = 'SALES_MEETING'
    )::int AS created_sales_meeting,
    COUNT(jc.id) FILTER (
      WHERE jc.status = 'COMPLETED'
        AND jc.manager_approved_at >=
        (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
        AND jc.manager_approved_at <
        ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
    )::int AS manager_approved,
    COUNT(jc.id) FILTER (
      WHERE jc.source_job_card_id IS NOT NULL
        AND jc.created_at >=
        (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
        AND jc.created_at <
        ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
    )::int AS follow_up_children`;

const CUSTOMER_REPORT_COUNT_SQL = `SELECT COUNT(*)::int AS total
FROM customers c
WHERE c.organization_id = $1
  AND ($2::text IS NULL OR c.name ILIKE $2 ESCAPE '\\')
  AND ($3::text IS NULL OR c.status = $3)
  AND ($4::text IS NULL OR c.customer_type = $4)`;

const CUSTOMER_REPORT_SQL = `WITH ${ORGANIZATION_RANGE_CTE}, customer_scope AS (
  SELECT c.id, c.name, c.customer_type, c.status
  FROM customers c
  WHERE c.organization_id = $1
    AND ($5::text IS NULL OR c.name ILIKE $5 ESCAPE '\\')
    AND ($6::text IS NULL OR c.status = $6)
    AND ($7::text IS NULL OR c.customer_type = $7)
), customer_page AS (
  SELECT customer_scope.*
  FROM customer_scope
  ORDER BY customer_scope.name COLLATE "C" ASC, customer_scope.id ASC
  LIMIT $8
  OFFSET $9
), activity AS (
  SELECT jc.customer_id,${CUSTOMER_REPORT_ACTIVITY_COLUMNS}
  FROM job_cards jc
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
  GROUP BY jc.customer_id
)
SELECT customer_page.id, customer_page.name, customer_page.customer_type,
  customer_page.status,
  COALESCE(activity.active, 0)::int AS active,
  COALESCE(activity.actionable, 0)::int AS actionable,
  COALESCE(activity.waiting_approval, 0)::int AS waiting_approval,
  COALESCE(activity.revision_requested, 0)::int AS revision_requested,
  COALESCE(activity.overdue, 0)::int AS overdue,
  COALESCE(activity.created, 0)::int AS created,
  COALESCE(activity.created_product_delivery, 0)::int AS created_product_delivery,
  COALESCE(activity.created_general_task, 0)::int AS created_general_task,
  COALESCE(activity.created_sales_meeting, 0)::int AS created_sales_meeting,
  COALESCE(activity.manager_approved, 0)::int AS manager_approved,
  COALESCE(activity.follow_up_children, 0)::int AS follow_up_children
FROM customer_page
LEFT JOIN activity ON activity.customer_id = customer_page.id
ORDER BY customer_page.name COLLATE "C" ASC, customer_page.id ASC`;

const CUSTOMER_REPORT_UNASSIGNED_SQL = `WITH ${ORGANIZATION_RANGE_CTE}
SELECT${CUSTOMER_REPORT_ACTIVITY_COLUMNS}
FROM job_cards jc
CROSS JOIN organization_range
WHERE jc.organization_id = $1
  AND jc.customer_id IS NULL`;

/**
 * R2D-1 frozen semantics:
 * - outcome cohort = COMPLETED Sales Meetings whose current meeting_at falls in the
 *   selected range, grouped by the CURRENT mutable meeting_details.outcome;
 *   a later outcome change intentionally moves the historical cohort result.
 * - outcomes with NULL current value are excluded, exactly like the canonical
 *   R2B staff outcome distribution; the distribution never claims to cover
 *   every completed meeting.
 * - proposal queue = Sales Meeting parents with proposal fields present AND
 *   status IN (WAITING_APPROVAL, REVISION_REQUESTED). No generic "pending"
 *   proposal status exists.
 * - overdue = active children with due_date strictly before organization-local
 *   today; automatic approve-created children have due_date NULL and never
 *   count here.
 * - divergence = child.source_job_card_id IS NOT NULL AND current parent
 *   customer_id IS DISTINCT FROM child.customer_id.
 */
const SALES_FOLLOW_UP_AGGREGATE_SQL = `WITH ${ORGANIZATION_RANGE_CTE}, active_statuses(status, sort_order) AS (
  VALUES ${ACTIVE_STATUS_BUCKETS_SQL}
), work_types(type, sort_order) AS (
  VALUES ${WORK_TYPE_BUCKETS_SQL}
), outcomes(outcome, sort_order) AS (
  VALUES
    ('POSITIVE', 1),
    ('FOLLOW_UP_REQUIRED', 2),
    ('NO_DECISION', 3),
    ('NOT_INTERESTED', 4)
), current_sales_meetings AS (
  SELECT jc.id
  FROM job_cards jc
  WHERE jc.organization_id = $1
    AND jc.type = 'SALES_MEETING'
    AND jc.status IN (${ACTIVE_STATUS_LIST_SQL})
), proposal_queue AS (
  SELECT jc.id
  FROM job_cards jc
  WHERE jc.organization_id = $1
    AND jc.type = 'SALES_MEETING'
    AND jc.follow_up_proposed_at IS NOT NULL
    AND jc.status IN ('WAITING_APPROVAL', 'REVISION_REQUESTED')
), follow_up_children AS (
  SELECT jc.id, jc.status, jc.type, jc.due_date, jc.customer_id,
    jc.created_at, parent.customer_id AS parent_customer_id
  FROM job_cards jc
  JOIN job_cards parent ON parent.organization_id = jc.organization_id
    AND parent.id = jc.source_job_card_id
  WHERE jc.organization_id = $1
    AND jc.source_job_card_id IS NOT NULL
), active_children AS (
  SELECT * FROM follow_up_children
  WHERE status IN (${ACTIVE_STATUS_LIST_SQL})
), sales_meeting_status_distribution AS (
  SELECT active_statuses.status, active_statuses.sort_order,
    COUNT(jc.id)::int AS count
  FROM active_statuses
  LEFT JOIN job_cards jc ON jc.organization_id = $1
    AND jc.type = 'SALES_MEETING'
    AND jc.status = active_statuses.status
  GROUP BY active_statuses.status, active_statuses.sort_order
), child_status_distribution AS (
  SELECT active_statuses.status, active_statuses.sort_order,
    COUNT(children.id)::int AS count
  FROM active_statuses
  LEFT JOIN active_children children ON children.status = active_statuses.status
  GROUP BY active_statuses.status, active_statuses.sort_order
), child_type_distribution AS (
  SELECT work_types.type, work_types.sort_order,
    COUNT(children.id)::int AS count
  FROM work_types
  LEFT JOIN active_children children ON children.type = work_types.type
  GROUP BY work_types.type, work_types.sort_order
), children_created_by_type AS (
  SELECT work_types.type, work_types.sort_order,
    COUNT(children.id)::int AS count
  FROM work_types
  CROSS JOIN organization_range
  LEFT JOIN follow_up_children children ON children.type = work_types.type
    AND children.created_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND children.created_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
  GROUP BY work_types.type, work_types.sort_order
), outcome_counts AS (
  SELECT md.outcome, COUNT(*)::int AS count
  FROM job_card_meeting_details md
  JOIN job_cards jc ON jc.organization_id = md.organization_id
    AND jc.id = md.job_card_id
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.type = 'SALES_MEETING'
    AND jc.status = 'COMPLETED'
    AND md.meeting_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND md.meeting_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
  GROUP BY md.outcome
), outcome_distribution AS (
  SELECT outcomes.outcome, outcomes.sort_order,
    COALESCE(outcome_counts.count, 0)::int AS count
  FROM outcomes
  LEFT JOIN outcome_counts ON outcome_counts.outcome = outcomes.outcome
), period_created AS (
  SELECT COUNT(jc.id)::int AS count
  FROM job_cards jc
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.type = 'SALES_MEETING'
    AND jc.created_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.created_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
), period_manager_approved AS (
  SELECT COUNT(jc.id)::int AS count
  FROM job_cards jc
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.type = 'SALES_MEETING'
    AND jc.status = 'COMPLETED'
    AND jc.manager_approved_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.manager_approved_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
), children_created AS (
  SELECT COUNT(children.id)::int AS count
  FROM follow_up_children children
  CROSS JOIN organization_range
  WHERE children.created_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND children.created_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
), overdue_children AS (
  SELECT COUNT(children.id)::int AS count
  FROM active_children children
  CROSS JOIN organization_range
  WHERE children.due_date IS NOT NULL
    AND children.due_date <
      ($4::timestamptz AT TIME ZONE organization_range.timezone)::date
), divergence AS (
  SELECT COUNT(children.id)::int AS count
  FROM follow_up_children children
  WHERE children.parent_customer_id IS DISTINCT FROM children.customer_id
)
SELECT to_char(organization_range.from_date, 'YYYY-MM-DD') AS from_date,
  to_char(organization_range.to_date, 'YYYY-MM-DD') AS to_date,
  organization_range.timezone,
  (SELECT COUNT(*) FROM current_sales_meetings)::int AS current_sales_meetings_total,
  (SELECT COUNT(*) FROM proposal_queue)::int AS proposal_queue_total,
  (SELECT COUNT(*) FROM active_children)::int AS active_children_total,
  (SELECT count FROM overdue_children)::int AS overdue_due_dated_follow_up_children,
  (SELECT count FROM period_created)::int AS sales_meetings_created,
  (SELECT count FROM period_manager_approved)::int AS sales_meetings_manager_approved,
  (SELECT count FROM children_created)::int AS follow_up_children_created,
  (SELECT COUNT(*) FROM follow_up_children)::int AS direct_follow_up_links,
  (SELECT count FROM divergence)::int AS current_customer_divergence,
  COALESCE((
    SELECT json_agg(json_build_object(
      'status', distribution.status,
      'count', distribution.count
    ) ORDER BY distribution.sort_order)
    FROM sales_meeting_status_distribution distribution
  ), '[]'::json) AS sales_meeting_status_distribution,
  COALESCE((
    SELECT json_agg(json_build_object(
      'status', distribution.status,
      'count', distribution.count
    ) ORDER BY distribution.sort_order)
    FROM child_status_distribution distribution
  ), '[]'::json) AS child_status_distribution,
  COALESCE((
    SELECT json_agg(json_build_object(
      'type', distribution.type,
      'count', distribution.count
    ) ORDER BY distribution.sort_order)
    FROM child_type_distribution distribution
  ), '[]'::json) AS child_type_distribution,
  COALESCE((
    SELECT json_agg(json_build_object(
      'type', distribution.type,
      'count', distribution.count
    ) ORDER BY distribution.sort_order)
    FROM children_created_by_type distribution
  ), '[]'::json) AS children_created_by_type,
  COALESCE((
    SELECT json_agg(json_build_object(
      'outcome', distribution.outcome,
      'count', distribution.count
    ) ORDER BY distribution.sort_order)
    FROM outcome_distribution distribution
  ), '[]'::json) AS outcome_distribution
FROM organization_range`;

const SALES_MEETING_QUEUE_SQL = `SELECT jc.id, jc.status, jc.scheduled_at,
  c.id AS customer_id, c.name AS customer_name,
  u.id AS assignee_id, u.name AS assignee_name
FROM job_cards jc
JOIN users u ON u.organization_id = jc.organization_id
  AND u.id = jc.assigned_to
LEFT JOIN customers c ON c.organization_id = jc.organization_id
  AND c.id = jc.customer_id
WHERE jc.organization_id = $1
  AND jc.type = 'SALES_MEETING'
  AND jc.status IN (${ACTIVE_STATUS_LIST_SQL})
ORDER BY jc.scheduled_at ASC NULLS LAST, jc.id ASC
LIMIT $2
OFFSET $3`;

const SALES_MEETING_QUEUE_COUNT_SQL = `SELECT COUNT(*)::int AS total
FROM job_cards jc
WHERE jc.organization_id = $1
  AND jc.type = 'SALES_MEETING'
  AND jc.status IN (${ACTIVE_STATUS_LIST_SQL})`;

const PROPOSAL_QUEUE_SQL = `SELECT jc.id, jc.status, jc.follow_up_proposed_at,
  jc.follow_up_proposed_type, jc.follow_up_proposal_instructions,
  jc.follow_up_proposal_origin,
  c.id AS customer_id, c.name AS customer_name,
  u.id AS assignee_id, u.name AS assignee_name,
  pu.id AS proposed_assignee_id, pu.name AS proposed_assignee_name
FROM job_cards jc
JOIN users u ON u.organization_id = jc.organization_id
  AND u.id = jc.assigned_to
LEFT JOIN customers c ON c.organization_id = jc.organization_id
  AND c.id = jc.customer_id
LEFT JOIN users pu ON pu.organization_id = jc.organization_id
  AND pu.id = jc.follow_up_proposed_assignee
WHERE jc.organization_id = $1
  AND jc.type = 'SALES_MEETING'
  AND jc.follow_up_proposed_at IS NOT NULL
  AND jc.status IN ('WAITING_APPROVAL', 'REVISION_REQUESTED')
ORDER BY jc.follow_up_proposed_at ASC NULLS LAST, jc.id ASC
LIMIT 50`;

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

function mapApprovalSummary(row: ApprovalSummaryRow): ApprovalSummary {
  return {
    pendingCount: Number(row.pending_count),
    oldestWaitingMinutes: row.oldest_waiting_minutes === null
      ? null
      : Number(row.oldest_waiting_minutes),
    averageWaitingMinutes: row.average_waiting_minutes === null
      ? null
      : Number(row.average_waiting_minutes),
    under2Hours: Number(row.under_2_hours),
    between2And8Hours: Number(row.between_2_and_8_hours),
    between8And24Hours: Number(row.between_8_and_24_hours),
    over24Hours: Number(row.over_24_hours),
  };
}

function mapCustomerReportActivity(row: {
  active: string | number;
  actionable: string | number;
  waiting_approval: string | number;
  revision_requested: string | number;
  overdue: string | number;
  created: string | number;
  created_product_delivery: string | number;
  created_general_task: string | number;
  created_sales_meeting: string | number;
  manager_approved: string | number;
  follow_up_children: string | number;
}): CustomerReportActivity {
  return {
    snapshot: {
      active: Number(row.active),
      actionable: Number(row.actionable),
      waitingApproval: Number(row.waiting_approval),
      revisionRequested: Number(row.revision_requested),
      overdue: Number(row.overdue),
    },
    period: {
      created: Number(row.created),
      createdWorkTypes: {
        PRODUCT_DELIVERY: Number(row.created_product_delivery),
        GENERAL_TASK: Number(row.created_general_task),
        SALES_MEETING: Number(row.created_sales_meeting),
      },
      managerApproved: Number(row.manager_approved),
      followUpChildren: Number(row.follow_up_children),
    },
  };
}

function mapCustomerReportItem(row: CustomerReportRow): CustomerReportItem {
  return {
    customer: {
      id: row.id,
      name: row.name,
      customerType: row.customer_type as CustomerReportItem['customer']['customerType'],
      status: row.status as CustomerReportItem['customer']['status'],
    },
    activity: mapCustomerReportActivity(row),
  };
}

function mapCustomerReportUnassigned(row: CustomerReportUnassignedRow): CustomerReportUnassigned {
  return { ...mapCustomerReportActivity(row) };
}

function mapSalesFollowUpDistribution(
  rows: Array<{ status: JobCardStatus; count: string | number }>,
): SalesFollowUpStatusDistributionItem[] {
  return rows.map((row) => ({ status: row.status, count: Number(row.count) }));
}

function mapSalesFollowUpTypeDistribution(
  rows: Array<{ type: JobCardType; count: string | number }>,
): SalesFollowUpTypeDistributionItem[] {
  return rows.map((row) => ({ type: row.type, count: Number(row.count) }));
}

function mapSalesFollowUpAggregate(row: SalesFollowUpAggregateRow) {
  return {
    range: {
      from: row.from_date,
      to: row.to_date,
      timezone: row.timezone,
    },
    current: {
      salesMeetings: {
        total: Number(row.current_sales_meetings_total),
        statusDistribution: mapSalesFollowUpDistribution(row.sales_meeting_status_distribution),
        items: [],
        limit: 0,
        offset: 0,
      },
      proposalQueue: {
        total: Number(row.proposal_queue_total),
        items: [],
      },
      followUpChildren: {
        total: Number(row.active_children_total),
        statusDistribution: mapSalesFollowUpDistribution(row.child_status_distribution),
        typeDistribution: mapSalesFollowUpTypeDistribution(row.child_type_distribution),
        overdueDueDatedFollowUpChildren: Number(row.overdue_due_dated_follow_up_children),
      },
    },
    period: {
      salesMeetingsCreated: Number(row.sales_meetings_created),
      salesMeetingsManagerApproved: Number(row.sales_meetings_manager_approved),
      meetingOutcomeDistribution: row.outcome_distribution.map((item) => ({
        outcome: item.outcome,
        count: Number(item.count),
      })),
      followUpChildrenCreated: Number(row.follow_up_children_created),
      followUpChildrenCreatedByType: mapSalesFollowUpTypeDistribution(
        row.children_created_by_type,
      ),
    },
    relationships: {
      directFollowUpLinks: Number(row.direct_follow_up_links),
      currentCustomerDivergence: Number(row.current_customer_divergence),
    },
  };
}

function mapSalesMeetingQueueRow(row: SalesMeetingQueueRow) {
  return {
    id: row.id,
    status: row.status,
    scheduledAt: row.scheduled_at === null ? null : row.scheduled_at.toISOString(),
    customer: row.customer_id === null
      ? null
      : { id: row.customer_id, name: row.customer_name! },
    assignee: { userId: row.assignee_id, name: row.assignee_name },
  };
}

function mapProposalQueueRow(row: ProposalQueueRow): ProposalQueueItem {
  return {
    id: row.id,
    status: row.status,
    customer: row.customer_id === null
      ? null
      : { id: row.customer_id, name: row.customer_name! },
    assignee: { userId: row.assignee_id, name: row.assignee_name },
    followUpProposedType: row.follow_up_proposed_type,
    followUpProposedAssignee: row.proposed_assignee_id === null
      ? null
      : { userId: row.proposed_assignee_id, name: row.proposed_assignee_name! },
    followUpProposalInstructions: row.follow_up_proposal_instructions,
    proposedFollowUpAt: row.follow_up_proposed_at === null
      ? null
      : row.follow_up_proposed_at.toISOString(),
    followUpProposalOrigin: row.follow_up_proposal_origin,
  };
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
    currentWorkloadByType: (row.current_workload_by_type ?? []).map((item) => ({
      type: item.type,
      count: Number(item.count),
    })),
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
    dailyCreatedTrend: row.daily_created_trend.map((point) => ({
      date: point.date,
      count: Number(point.count),
    })),
    activeStatusDistribution: row.active_status_distribution.map((point) => ({
      status: point.status,
      count: Number(point.count),
    })),
    createdWorkTypeDistribution: row.created_work_type_distribution.map((point) => ({
      type: point.type,
      count: Number(point.count),
    })),
  };
}

export class PostgresReportsRepository implements ReportsReadModel {
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

  async getStaffPerformanceScope(
    input: StaffPerformanceScopeInput,
  ): Promise<StaffPerformanceScope> {
    const result = await this.pool.query<StaffPerformanceScopeRow>(
      STAFF_PERFORMANCE_SCOPE_SQL,
      [
        input.organizationId,
        input.requestedRange?.from ?? null,
        input.requestedRange?.to ?? null,
        input.requestTime,
        input.includeInactive,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Staff performance organization range could not be resolved.');
    return {
      range: {
        from: row.from_date,
        to: row.to_date,
        timezone: row.timezone,
      },
      staff: row.staff,
    };
  }

  async getStaffCompletionPerformanceMany(
    input: StaffOperationalSummaryManyInput,
  ): Promise<ReadonlyMap<string, StaffCompletionPerformance>> {
    const staffUserIds = [...new Set(input.staffUserIds)];
    if (staffUserIds.length === 0) return new Map();
    const result = await this.pool.query<StaffCompletionPerformanceRow>(
      STAFF_COMPLETION_PERFORMANCE_SQL,
      [
        input.organizationId,
        input.requestedRange?.from ?? null,
        input.requestedRange?.to ?? null,
        input.requestTime,
        staffUserIds,
      ],
    );
    return new Map(result.rows.map((row) => [
      row.staff_user_id,
      {
        staffUserId: row.staff_user_id,
        completionDays: Number(row.completion_days),
        completionWorkTypes: row.completion_work_types.map((item) => ({
          type: item.type,
          count: Number(item.count),
        })),
      },
    ]));
  }

  async getStaffExecutionMany(
    input: StaffOperationalSummaryManyInput,
  ): Promise<ReadonlyMap<string, StaffExecutionAggregate>> {
    const staffUserIds = [...new Set(input.staffUserIds)];
    if (staffUserIds.length === 0) return new Map();
    const result = await this.pool.query<StaffExecutionRow>(STAFF_EXECUTION_SQL, [
      input.organizationId,
      input.requestedRange?.from ?? null,
      input.requestedRange?.to ?? null,
      input.requestTime,
      staffUserIds,
    ]);
    return new Map(result.rows.map((row) => [row.staff_user_id, {
      staffUserId: row.staff_user_id,
      staffCompletedJobs: Number(row.staff_completed_jobs),
      staffCompletionDays: Number(row.staff_completion_days),
      missingStaffCompletionTimestamp: Number(row.missing_staff_completion_timestamp),
      recordedSubmissionCount: Number(row.recorded_submission_count),
      recordedSubmissionDays: Number(row.recorded_submission_days),
    }]));
  }

  async getStaffOnTimeMany(
    input: StaffOperationalSummaryManyInput,
  ): Promise<ReadonlyMap<string, StaffOnTimeAggregate>> {
    const staffUserIds = [...new Set(input.staffUserIds)];
    if (staffUserIds.length === 0) return new Map();
    const result = await this.pool.query<StaffOnTimeRow>(STAFF_ON_TIME_SQL, [
      input.organizationId,
      input.requestedRange?.from ?? null,
      input.requestedRange?.to ?? null,
      input.requestTime,
      staffUserIds,
    ]);
    return new Map(result.rows.map((row) => [row.staff_user_id, {
      staffUserId: row.staff_user_id,
      eligibleScheduledCompletedJobs: Number(row.eligible_scheduled_completed_jobs),
      onTimeCompletedJobs: Number(row.on_time_completed_jobs),
      lateCompletedJobs: Number(row.late_completed_jobs),
      ineligibleOrNoDeadlineCompletedJobs: Number(
        row.ineligible_or_no_deadline_completed_jobs,
      ),
    }]));
  }

  async getStaffCorrectionRequestEventsMany(
    input: StaffOperationalSummaryManyInput,
  ): Promise<ReadonlyMap<string, number>> {
    return this.getStaffGroupedCounts(STAFF_CORRECTION_EVENTS_SQL, input);
  }

  async getStaffAuthoredOperationalNotesMany(
    input: StaffOperationalSummaryManyInput,
  ): Promise<ReadonlyMap<string, number>> {
    return this.getStaffGroupedCounts(STAFF_AUTHORED_OPERATIONAL_NOTES_SQL, input);
  }

  async getStaffDailyCompletionTrend(input: StaffOperationalSummaryOneInput) {
    const result = await this.pool.query<DailyCompletionRow>(
      STAFF_DAILY_COMPLETION_TREND_SQL,
      [
        input.organizationId,
        input.staffUserId,
        input.requestedRange?.from ?? null,
        input.requestedRange?.to ?? null,
        input.requestTime,
      ],
    );
    return result.rows.map((row) => ({ date: row.date, count: Number(row.count) }));
  }

  async getStaffIdentity(input: {
    organizationId: string;
    staffUserId: string;
  }): Promise<ReportStaffLifecycleIdentity | null> {
    const result = await this.pool.query<StaffIdentityRow>(STAFF_IDENTITY_SQL, [
      input.organizationId,
      input.staffUserId,
    ]);
    const row = result.rows[0];
    return row
      ? {
          userId: row.id,
          name: row.name,
          isActive: row.is_active,
          createdAt: row.created_at.toISOString(),
        }
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

  async getStaffMeetingsByOutcome(
    input: StaffOperationalSummaryOneInput,
  ): Promise<MeetingOutcomeItem[]> {
    const result = await this.pool.query<MeetingOutcomeRow>(
      STAFF_MEETINGS_BY_OUTCOME_SQL,
      [
        input.organizationId,
        input.staffUserId,
        input.requestedRange?.from ?? null,
        input.requestedRange?.to ?? null,
        input.requestTime,
      ],
    );
    return result.rows.map((row) => ({
      outcome: row.outcome,
      count: Number(row.count),
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

  async getApprovalSummary(input: {
    organizationId: string;
    requestTime: Date;
  }): Promise<ApprovalSummary> {
    const result = await this.pool.query<ApprovalSummaryRow>(APPROVAL_SUMMARY_SQL, [
      input.organizationId,
      input.requestTime,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error('Approval summary could not be resolved.');
    return mapApprovalSummary(row);
  }

  async getWorkTypeDistribution(
    input: WorkTypeDistributionInput,
  ): Promise<WorkTypeDistributionItem[]> {
    const staffFilter = input.staffUserId ? 'AND j.assigned_to = $4' : '';
    const values: unknown[] = [input.organizationId, input.from, input.to];
    if (input.staffUserId) values.push(input.staffUserId);
    const result = await this.pool.query<{ type: string; count: string }>(
      `SELECT j.type, COUNT(*)::int AS count
         FROM job_cards j
         JOIN organizations o ON o.id = j.organization_id
        WHERE j.organization_id = $1
          AND j.created_at >= ($2::date AT TIME ZONE o.timezone)
          AND j.created_at < (($3::date + 1) AT TIME ZONE o.timezone)
          ${staffFilter}
        GROUP BY j.type
        ORDER BY count DESC, j.type ASC
        LIMIT 10`,
      values,
    );
    return result.rows.map((row) => ({
      type: row.type,
      count: parseInt(row.count, 10),
    }));
  }

  async getCustomerReport(input: CustomerReportReadInput): Promise<CustomerReportResponse> {
    const rangeValues = [
      input.organizationId,
      input.requestedRange?.from ?? null,
      input.requestedRange?.to ?? null,
      input.requestTime,
    ];
    const rangeResult = await this.pool.query<ResolvedReportRangeRow>(
      RESOLVED_REPORT_RANGE_SQL,
      rangeValues,
    );
    const resolvedRange = rangeResult.rows[0];
    if (!resolvedRange) {
      throw new Error('Customer report organization range could not be resolved.');
    }

    const search = input.search?.replace(/[\\%_]/g, '\\$&') ?? null;
    const searchPattern = search === null ? null : `%${search}%`;
    const [countResult, pageResult, unassignedResult] = await Promise.all([
      this.pool.query<{ total: string | number }>(CUSTOMER_REPORT_COUNT_SQL, [
        input.organizationId,
        searchPattern,
        input.status,
        input.customerType,
      ]),
      this.pool.query<CustomerReportRow>(CUSTOMER_REPORT_SQL, [
        ...rangeValues,
        searchPattern,
        input.status,
        input.customerType,
        input.limit,
        input.offset,
      ]),
      this.pool.query<CustomerReportUnassignedRow>(CUSTOMER_REPORT_UNASSIGNED_SQL, rangeValues),
    ]);

    const countRow = countResult.rows[0];
    const unassignedRow = unassignedResult.rows[0];
    if (!countRow) {
      throw new Error('Customer report total count could not be resolved.');
    }
    if (!unassignedRow) {
      throw new Error('Customer report unassigned reconciliation could not be resolved.');
    }
    return {
      range: resolvedRange,
      total: Number(countRow.total),
      limit: input.limit,
      offset: input.offset,
      items: pageResult.rows.map(mapCustomerReportItem),
      unassigned: mapCustomerReportUnassigned(unassignedRow),
    };
  }

  async getSalesFollowUpReport(
    input: SalesFollowUpReportReadInput,
  ): Promise<SalesFollowUpReportResponse> {
    const rangeValues = [
      input.organizationId,
      input.requestedRange?.from ?? null,
      input.requestedRange?.to ?? null,
      input.requestTime,
    ];
    const rangeResult = await this.pool.query<ResolvedReportRangeRow>(
      RESOLVED_REPORT_RANGE_SQL,
      rangeValues,
    );
    const resolvedRange = rangeResult.rows[0];
    if (!resolvedRange) {
      throw new Error('Sales follow-up report organization range could not be resolved.');
    }
    const [aggregateResult, queueCountResult, queuePageResult, proposalQueueResult]
      = await Promise.all([
        this.pool.query<SalesFollowUpAggregateRow>(
          SALES_FOLLOW_UP_AGGREGATE_SQL,
          rangeValues,
        ),
        this.pool.query<{ total: string | number }>(SALES_MEETING_QUEUE_COUNT_SQL, [
          input.organizationId,
        ]),
        this.pool.query<SalesMeetingQueueRow>(SALES_MEETING_QUEUE_SQL, [
          input.organizationId,
          input.limit,
          input.offset,
        ]),
        this.pool.query<ProposalQueueRow>(PROPOSAL_QUEUE_SQL, [
          input.organizationId,
        ]),
      ]);
    const aggregateRow = aggregateResult.rows[0];
    if (!aggregateRow) {
      throw new Error('Sales follow-up report aggregate could not be resolved.');
    }
    const queueCountRow = queueCountResult.rows[0];
    if (!queueCountRow) {
      throw new Error('Sales follow-up queue count could not be resolved.');
    }
    const aggregate = mapSalesFollowUpAggregate(aggregateRow);
    return {
      range: resolvedRange,
      current: {
        ...aggregate.current,
        salesMeetings: {
          total: Number(queueCountRow.total),
          statusDistribution: aggregate.current.salesMeetings.statusDistribution,
          items: queuePageResult.rows.map(mapSalesMeetingQueueRow),
          limit: input.limit,
          offset: input.offset,
        },
        proposalQueue: {
          total: aggregate.current.proposalQueue.total,
          items: proposalQueueResult.rows.map(mapProposalQueueRow),
        },
      },
      period: aggregate.period,
      relationships: aggregate.relationships,
    };
  }

  private async getStaffGroupedCounts(
    sql: string,
    input: StaffOperationalSummaryManyInput,
  ) {
    const staffUserIds = [...new Set(input.staffUserIds)];
    if (staffUserIds.length === 0) return new Map<string, number>();
    const result = await this.pool.query<StaffCountRow>(sql, [
      input.organizationId,
      input.requestedRange?.from ?? null,
      input.requestedRange?.to ?? null,
      input.requestTime,
      staffUserIds,
    ]);
    return new Map(result.rows.map((row) => [row.staff_user_id, Number(row.count)]));
  }
}
