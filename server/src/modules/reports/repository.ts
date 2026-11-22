import type { Pool } from 'pg';

import type { SqlExecutor } from '../../db/executor.js';
import {
  ACTIVE_JOB_CARD_STATUSES,
  type FollowUpProposalOrigin,
  type JobCardStatus,
  type JobCardType,
  type JobChangeRequestReasonCode,
} from '../job-cards/types.js';
import { currentOverduePredicateSql } from '../job-cards/overdue-contract.js';
import { assigneeAtInstantSql } from '../job-cards/assignment-history-sql.js';
import type { ReportsReadModel } from './ports.js';
import { ORGANIZATION_RANGE_CTE } from './range-sql.js';
import { readBusinessTrend } from './business-trend.js';
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
  LatenessDelayType,
  LatenessDurationStats,
  LatenessOpenStats,
  LatenessOperationalResolution,
  LatenessOutcome,
  MeetingOutcomeItem,
  OrganizationLatenessAggregate,
  ProposalQueueItem,
  ReportStaffLifecycleIdentity,
  ResolvedReportRange,
  SalesFollowUpReportReadInput,
  SalesFollowUpReportResponse,
  SalesFollowUpStatusDistributionItem,
  SalesFollowUpTypeDistributionItem,
  StaffCompletionPerformance,
  StaffExecutionAggregate,
  StaffLatenessAggregate,
  StaffLatenessIncidentListInput,
  StaffLatenessIncidentListResponse,
  StaffLatenessIncidentItem,
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
  weekly_report_workload: string | number;
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
  created_sale: string | number;
  manager_approved: string | number;
  follow_up_children: string | number;
};

type CustomerReportUnassignedRow = Omit<CustomerReportRow, 'id' | 'name' | 'customer_type' | 'status'>;

type SalesFollowUpAggregateRow = {
  from_date: string;
  to_date: string;
  timezone: string;
  current_sales_meetings_total: string | number;
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

type LatenessDurationJson = {
  count: string | number;
  medianSeconds: string | number | null;
  maxSeconds: string | number | null;
};

type LatenessTypeJson = {
  delayType: LatenessDelayType;
  incidentCount: string | number;
  recovered: LatenessDurationJson;
  extended: LatenessDurationJson;
  open: { count: string | number; maxElapsedSeconds: string | number | null };
};

type StaffLatenessSummaryRow = {
  invalid_delay_type_count: string | number;
  responsibility_delayed_job_count: string | number;
  responsibility_incident_count: string | number;
  by_type: LatenessTypeJson[];
  operational_delayed_job_count: string | number;
  operational_incident_count: string | number;
  by_reason: Array<{
    reasonCode: JobChangeRequestReasonCode;
    incidentCount: string | number;
  }>;
};

type OrganizationLatenessSummaryRow = ResolvedReportRangeRow & {
  total_incident_count: string | number;
  staff_responsibility_delayed_job_count: string | number;
  staff_responsibility_incident_count: string | number;
  operational_delayed_job_count: string | number;
  operational_incident_count: string | number;
  unknown_delayed_job_count: string | number;
  unknown_incident_count: string | number;
  management_delayed_job_count: string | number;
  management_incident_count: string | number;
  management_recovered: LatenessDurationJson;
  management_open: { count: string | number; maxElapsedSeconds: string | number | null };
};

type LatenessIncidentRow = {
  incident_id: string;
  /** Checked in mapLatenessIncident; the SQL does not constrain it. */
  delay_type: string;
  episode_no: number;
  schedule_revision_no: number;
  deadline_at: Date;
  breached_at: Date;
  outcome: LatenessOutcome;
  closed_at: Date | null;
  duration_seconds: number;
  operational_reason_code: JobChangeRequestReasonCode | null;
  operational_resolution: LatenessOperationalResolution | null;
  operational_resolved_at: Date | null;
  job: { id: string; title: string; type: JobCardType } | null;
};

type DeliveryGroupDefinition = {
  select: string;
  group: string;
  order: string;
};

/**
 * Canonical overdue predicate, rendered from the single shared contract in
 * `job-cards/overdue-contract.ts`: due_date strictly before the
 * organization-local current date, independent of scheduled_at. `$4` is the
 * requestTime instant.
 */
const OVERDUE_JOB_CARD_CLAUSE = currentOverduePredicateSql({
  dueDate: 'jc.due_date',
  timezone: 'organization_range.timezone',
  requestTime: '$4::timestamptz',
  status: 'jc.status',
  jobType: 'jc.type',
});

const ACTIVE_STATUS_LIST_SQL = ACTIVE_JOB_CARD_STATUSES.map((status) => `'${status}'`).join(', ');
const ACTIVE_STATUS_BUCKETS_SQL = ACTIVE_JOB_CARD_STATUSES
  .map((status, index) => `('${status}', ${index + 1})`)
  .join(',\n    ');
/**
 * Productive work-type buckets. `WEEKLY_REPORT` is an administrative reporting
 * artifact, not customer/service work: it must never appear as an ordinary
 * productive-work category, so buckets derive from this explicit list rather
 * than the full `JOB_CARD_TYPES` union.
 */
const PRODUCTIVE_WORK_TYPES = ['PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING', 'SALE'] as const;
const workTypeBucketsSql = (includeSaleCapability: boolean) => PRODUCTIVE_WORK_TYPES
  .filter((type) => includeSaleCapability || type !== 'SALE')
  .map((type, index) => `('${type}', ${index + 1})`)
  .join(',\n    ');
/**
 * Productive-work aggregate guard. Completion/execution/performance measures
 * must not count weekly reports as performed service work. Status counters
 * (open/waiting/revision) intentionally still include them: an outstanding
 * weekly report is outstanding assigned work.
 */
const productiveWorkOnly = (alias: string) => `${alias}.type <> 'WEEKLY_REPORT'`;

// Closed SQL source selection, shared by list/count/aggregate producers.
const saleReadableJobsSql = (includeSaleCapability: boolean) => includeSaleCapability
  ? 'job_cards' : "(SELECT * FROM job_cards WHERE type <> 'SALE')";
const STAFF_SUMMARY_SQL = (includeSaleCapability: boolean) => `WITH ${ORGANIZATION_RANGE_CTE}, requested AS (
  SELECT unnest($5::uuid[]) AS staff_user_id
), work_types(type, sort_order) AS (
  VALUES ${workTypeBucketsSql(includeSaleCapability)}
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
    WHERE jc.type = 'WEEKLY_REPORT'
      AND jc.status IN (${ACTIVE_STATUS_LIST_SQL})
  )::int AS weekly_report_workload,
  COUNT(jc.id) FILTER (
    WHERE jc.status IN (
        ${ACTIVE_STATUS_LIST_SQL}
      )
      AND (
        ${OVERDUE_JOB_CARD_CLAUSE}
      )
  )::int AS overdue_job_cards,
  (
    SELECT COUNT(completed_job.id)::int
    FROM ${saleReadableJobsSql(includeSaleCapability)} completed_job
    WHERE completed_job.organization_id = $1
      AND completed_job.staff_completed_by = requested.staff_user_id
      AND completed_job.status = 'COMPLETED'
      AND ${productiveWorkOnly('completed_job')}
      AND completed_job.manager_approved_at >=
        (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
      AND completed_job.manager_approved_at <
        ((organization_range.to_date + 1)::timestamp
          AT TIME ZONE organization_range.timezone)
  ) AS completed_in_period,
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
      LEFT JOIN ${saleReadableJobsSql(includeSaleCapability)} typed_job ON typed_job.organization_id = $1
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
LEFT JOIN ${saleReadableJobsSql(includeSaleCapability)} jc ON jc.organization_id = $1
  AND jc.assigned_to = requested.staff_user_id
GROUP BY requested.staff_user_id, organization_range.from_date,
  organization_range.to_date, organization_range.timezone
ORDER BY requested.staff_user_id`;

const DASHBOARD_SQL = (includeSaleCapability: boolean) => `WITH ${ORGANIZATION_RANGE_CTE}, counters AS (
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
        AND ${productiveWorkOnly('jc')}
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
  FROM ${saleReadableJobsSql(includeSaleCapability)} jc
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
  LEFT JOIN ${saleReadableJobsSql(includeSaleCapability)} jc ON jc.organization_id = $1
    AND ${productiveWorkOnly('jc')}
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
  LEFT JOIN ${saleReadableJobsSql(includeSaleCapability)} jc ON jc.organization_id = $1
    AND jc.status <> 'INVALIDATED'
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
  LEFT JOIN ${saleReadableJobsSql(includeSaleCapability)} jc ON jc.organization_id = $1
    AND jc.status = active_statuses.status
  GROUP BY active_statuses.status, active_statuses.sort_order
), work_types(type, sort_order) AS (
  VALUES ${workTypeBucketsSql(includeSaleCapability)}
), created_work_type_distribution AS (
  SELECT work_types.type, work_types.sort_order,
    COUNT(jc.id)::int AS count
  FROM work_types
  CROSS JOIN organization_range
  LEFT JOIN ${saleReadableJobsSql(includeSaleCapability)} jc ON jc.organization_id = $1
    AND jc.type = work_types.type
    AND jc.status <> 'INVALIDATED'
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

const STAFF_COMPLETION_PERFORMANCE_SQL = (includeSaleCapability: boolean) => `WITH ${ORGANIZATION_RANGE_CTE}, requested AS (
  SELECT unnest($5::uuid[]) AS staff_user_id
), completed AS (
  SELECT jc.staff_completed_by AS staff_user_id,
    (jc.manager_approved_at AT TIME ZONE organization_range.timezone)::date
      AS completion_date,
    jc.type
  FROM ${saleReadableJobsSql(includeSaleCapability)} jc
  JOIN requested ON requested.staff_user_id = jc.staff_completed_by
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.status = 'COMPLETED'
    AND ${productiveWorkOnly('jc')}
    AND jc.manager_approved_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.manager_approved_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
), completion_days AS (
  SELECT staff_user_id, COUNT(DISTINCT completion_date)::int AS completion_days
  FROM completed
  GROUP BY staff_user_id
), work_types(type, sort_order) AS (
  VALUES ${workTypeBucketsSql(includeSaleCapability)}
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

const STAFF_EXECUTION_SQL = (includeSaleCapability: boolean) => `WITH ${ORGANIZATION_RANGE_CTE}, requested AS (
  SELECT unnest($5::uuid[]) AS staff_user_id
), executed AS (
  SELECT jc.staff_completed_by AS staff_user_id,
    jc.staff_completed_at,
    (jc.staff_completed_at AT TIME ZONE organization_range.timezone)::date
      AS staff_completion_date
  FROM ${saleReadableJobsSql(includeSaleCapability)} jc
  JOIN requested ON requested.staff_user_id = jc.staff_completed_by
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.status = 'COMPLETED'
    AND ${productiveWorkOnly('jc')}
    AND jc.staff_completed_at IS NOT NULL
    AND jc.staff_completed_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.staff_completed_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
), approved_missing AS (
  SELECT jc.assigned_to AS staff_user_id
  FROM ${saleReadableJobsSql(includeSaleCapability)} jc
  JOIN requested ON requested.staff_user_id = jc.assigned_to
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.status = 'COMPLETED'
    AND ${productiveWorkOnly('jc')}
    AND jc.staff_completed_at IS NULL
    AND jc.manager_approved_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.manager_approved_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
), recorded_submissions AS (
  SELECT jc.staff_completed_by AS staff_user_id,
    (jc.staff_completed_at AT TIME ZONE organization_range.timezone)::date
      AS recorded_submission_date
  FROM ${saleReadableJobsSql(includeSaleCapability)} jc
  JOIN requested ON requested.staff_user_id = jc.staff_completed_by
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.staff_completed_at IS NOT NULL
    AND jc.staff_completed_by IS NOT NULL
    AND jc.status <> 'INVALIDATED'
    AND ${productiveWorkOnly('jc')}
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

const STAFF_ON_TIME_SQL = (includeSaleCapability: boolean) => `WITH ${ORGANIZATION_RANGE_CTE}, requested AS (
  SELECT unnest($5::uuid[]) AS staff_user_id
), completed AS (
  SELECT jc.staff_completed_by AS staff_user_id, jc.type, jc.staff_completed_at,
    jc.scheduled_at, jc.scheduled_ends_at,
    CASE
      WHEN jc.scheduled_ends_at IS NOT NULL THEN jc.scheduled_ends_at
      WHEN jc.type = 'SALES_MEETING' THEN NULL
      ELSE jc.scheduled_at
    END AS effective_deadline_at
  FROM ${saleReadableJobsSql(includeSaleCapability)} jc
  JOIN requested ON requested.staff_user_id = jc.staff_completed_by
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.status = 'COMPLETED'
    AND ${productiveWorkOnly('jc')}
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

const STAFF_CORRECTION_EVENTS_SQL = (includeSaleCapability: boolean) => `WITH ${ORGANIZATION_RANGE_CTE}, requested AS (
  SELECT unnest($5::uuid[]) AS staff_user_id
)
SELECT requested.staff_user_id, COUNT(activity.id)::int AS count
FROM requested
JOIN ${saleReadableJobsSql(includeSaleCapability)} jc ON jc.organization_id = $1
  AND jc.staff_completed_by = requested.staff_user_id
  AND jc.status <> 'INVALIDATED'
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

const STAFF_AUTHORED_OPERATIONAL_NOTES_SQL = (includeSaleCapability: boolean) => `WITH ${ORGANIZATION_RANGE_CTE}, requested AS (
  SELECT unnest($5::uuid[]) AS staff_user_id
)
SELECT requested.staff_user_id, COUNT(n.id)::int AS count
FROM requested
JOIN job_card_notes n ON n.organization_id = $1
  AND n.author_id = requested.staff_user_id
JOIN ${saleReadableJobsSql(includeSaleCapability)} jc ON jc.organization_id = n.organization_id
  AND jc.id = n.job_card_id
  AND jc.status <> 'INVALIDATED'
CROSS JOIN organization_range
WHERE (n.record_version = 0 OR n.context = 'GENERAL')
  AND n.created_at >=
    (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
  AND n.created_at <
    ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
GROUP BY requested.staff_user_id
ORDER BY requested.staff_user_id`;

const STAFF_DAILY_COMPLETION_TREND_SQL = (includeSaleCapability: boolean) => `WITH organization_range AS (
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
LEFT JOIN ${saleReadableJobsSql(includeSaleCapability)} jc ON jc.organization_id = $1
  AND jc.staff_completed_by = $2
  AND jc.status = 'COMPLETED'
  AND ${productiveWorkOnly('jc')}
  AND jc.manager_approved_at >=
    (days.day::timestamp AT TIME ZONE organization_range.timezone)
  AND jc.manager_approved_at <
    ((days.day + 1)::timestamp AT TIME ZONE organization_range.timezone)
GROUP BY days.day
ORDER BY days.day`;

const STAFF_DELIVERIES_BY_PURPOSE_SQL = (includeSaleCapability: boolean) => `WITH organization_range AS (
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
JOIN ${saleReadableJobsSql(includeSaleCapability)} jc ON jc.organization_id = di.organization_id
  AND jc.id = di.job_card_id
CROSS JOIN organization_range
WHERE jc.organization_id = $1
  AND jc.staff_completed_by = $2
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

const STAFF_MEETINGS_BY_OUTCOME_SQL = (includeSaleCapability: boolean) => `WITH organization_range AS (
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
  JOIN ${saleReadableJobsSql(includeSaleCapability)} jc ON jc.organization_id = md.organization_id
    AND jc.id = md.job_card_id
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.staff_completed_by = $2
    AND jc.type = 'SALES_MEETING'
    AND jc.status = 'COMPLETED'
    -- JOB-010 release 2a (D1 §4): a visit that did not take place has no
    -- meeting_at. It stays visible in the outcome distribution at the
    -- completion instant instead of being dropped.
    AND COALESCE(md.meeting_at, jc.staff_completed_at) >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND COALESCE(md.meeting_at, jc.staff_completed_at) <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
  GROUP BY md.outcome
)
SELECT outcomes.outcome, COALESCE(outcome_counts.count, 0)::int AS count
FROM outcomes
LEFT JOIN outcome_counts ON outcome_counts.outcome = outcomes.outcome
ORDER BY outcomes.sort_order`;

/**
 * OVR-7 shared lateness cohort (accepted contract §3, §4).
 *
 * One renderer feeds the Staff summary, the organization summary and the
 * paged incident list so the cohort, the outcome/duration rule and the
 * operational flag can never drift between reads.
 *
 * Classification partitions only on `accountable_role`, `accountable_source`
 * and `accountable_user_id`; an `APPROVAL_WAIT` row is management delay and
 * never enters a Staff group. The operational flag is a left lateral join so
 * no aggregate or page can count one incident twice; the provable-management
 * rule for a `CANCELLED` closure reads the historical assignee from the shared
 * `assigneeAtInstantSql` renderer, never from the current assignee.
 *
 * Bound parameters: $1 organization, $2 from date, $3 to date,
 * $4 requestTime.
 */
const latenessCohortSql = (includeSaleCapability: boolean) => `cohort AS (
  SELECT i.id,
    i.job_card_id,
    i.delay_type,
    i.episode_no,
    i.schedule_revision_no,
    i.deadline_at,
    i.breached_at,
    i.recovered_at,
    i.ended_at,
    i.accountable_role,
    i.accountable_source,
    i.accountable_user_id,
    CASE
      WHEN i.recovered_at IS NOT NULL THEN 'RECOVERED'
      WHEN i.ended_at IS NOT NULL THEN 'EXTENDED'
      ELSE 'OPEN'
    END AS outcome,
    COALESCE(i.recovered_at, i.ended_at, $4::timestamptz) AS duration_end_at
  FROM job_card_overdue_incidents i
  CROSS JOIN organization_range
  JOIN ${saleReadableJobsSql(includeSaleCapability)} jc
    ON jc.organization_id = i.organization_id AND jc.id = i.job_card_id
  WHERE i.organization_id = $1
    AND i.breached_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND i.breached_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.status <> 'INVALIDATED'
), classified AS (
  SELECT cohort.*,
    CASE
      WHEN cohort.accountable_role = 'STAFF'
        AND cohort.accountable_source = 'ASSIGNMENT_AT_BREACH'
        AND cohort.accountable_user_id IS NOT NULL THEN 'STAFF_PROVEN'
      WHEN cohort.accountable_role = 'STAFF' THEN 'STAFF_UNKNOWN'
      ELSE 'MANAGEMENT'
    END AS accountability,
    GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
      cohort.duration_end_at - cohort.breached_at
    ))))::int AS duration_seconds
  FROM cohort
), operational AS (
  SELECT classified.*,
    request.reason_code AS operational_reason_code,
    request.resolution AS operational_resolution,
    request.resolved_at AS operational_resolved_at
  FROM classified
  LEFT JOIN LATERAL (
    SELECT cr.reason_code, cr.resolution, cr.resolved_at
    FROM job_card_change_requests cr
    WHERE classified.accountability = 'STAFF_PROVEN'
      AND cr.organization_id = $1
      AND cr.job_card_id = classified.job_card_id
      AND cr.requested_by = classified.accountable_user_id
      AND cr.state = 'CLOSED'
      AND (
        cr.resolution IN ('CORRECTED', 'RESCHEDULED', 'LINKED_JOB_CREATED')
        OR (
          cr.resolution = 'CANCELLED'
          -- An unreadable historical assignee (NULL) is not proof: \`<>\`
          -- with NULL is never true, so nothing is guessed (contract §4.3).
          AND cr.resolved_by <> ${assigneeAtInstantSql({
            organizationId: '$1',
            jobCardId: 'classified.job_card_id',
            instant: 'cr.resolved_at',
          })}
        )
      )
      AND cr.requested_at <=
        COALESCE(classified.recovered_at, classified.ended_at, $4::timestamptz)
      AND cr.resolved_at >= classified.breached_at
    ORDER BY cr.resolved_at DESC, cr.id DESC
    LIMIT 1
  ) request ON TRUE
), flagged AS (
  SELECT operational.*,
    (operational.operational_reason_code IS NOT NULL) AS operational_flag
  FROM operational
)`;

const LATENESS_REASON_CODE_BUCKETS_SQL = `
  VALUES
    ('CUSTOMER_CHANGED_MIND', 1),
    ('CUSTOMER_POSTPONED', 2),
    ('CUSTOMER_ABSENT', 3),
    ('WRONG_PRODUCT', 4),
    ('MISSING_STOCK_OR_EQUIPMENT', 5),
    ('VISIT_NOT_POSSIBLE', 6),
    ('OTHER', 7)`;

const STAFF_LATENESS_SUMMARY_SQL = (includeSaleCapability: boolean) => `WITH ${ORGANIZATION_RANGE_CTE},
${latenessCohortSql(includeSaleCapability)},
staff_rows AS (
  SELECT flagged.* FROM flagged
  WHERE flagged.accountability = 'STAFF_PROVEN'
    AND flagged.accountable_user_id = $5::uuid
), type_buckets(delay_type, sort_order) AS (
  VALUES
    ('LATE_START', 1),
    ('LATE_SUBMISSION', 2)
), by_type AS (
  SELECT type_buckets.delay_type, type_buckets.sort_order,
    COALESCE(aggregate.incident_count, 0) AS incident_count,
    COALESCE(aggregate.recovered_count, 0) AS recovered_count,
    aggregate.recovered_median_seconds,
    aggregate.recovered_max_seconds,
    COALESCE(aggregate.extended_count, 0) AS extended_count,
    aggregate.extended_median_seconds,
    aggregate.extended_max_seconds,
    COALESCE(aggregate.open_count, 0) AS open_count,
    aggregate.open_max_elapsed_seconds
  FROM type_buckets
  LEFT JOIN (
    SELECT staff_rows.delay_type,
      COUNT(*) FILTER (WHERE NOT staff_rows.operational_flag)::int
        AS incident_count,
      COUNT(*) FILTER (
        WHERE NOT staff_rows.operational_flag AND staff_rows.outcome = 'RECOVERED'
      )::int AS recovered_count,
      FLOOR(percentile_cont(0.5) WITHIN GROUP (ORDER BY staff_rows.duration_seconds)
        FILTER (
          WHERE NOT staff_rows.operational_flag AND staff_rows.outcome = 'RECOVERED'
        ))::int AS recovered_median_seconds,
      MAX(staff_rows.duration_seconds) FILTER (
        WHERE NOT staff_rows.operational_flag AND staff_rows.outcome = 'RECOVERED'
      )::int AS recovered_max_seconds,
      COUNT(*) FILTER (
        WHERE NOT staff_rows.operational_flag AND staff_rows.outcome = 'EXTENDED'
      )::int AS extended_count,
      FLOOR(percentile_cont(0.5) WITHIN GROUP (ORDER BY staff_rows.duration_seconds)
        FILTER (
          WHERE NOT staff_rows.operational_flag AND staff_rows.outcome = 'EXTENDED'
        ))::int AS extended_median_seconds,
      MAX(staff_rows.duration_seconds) FILTER (
        WHERE NOT staff_rows.operational_flag AND staff_rows.outcome = 'EXTENDED'
      )::int AS extended_max_seconds,
      COUNT(*) FILTER (
        WHERE NOT staff_rows.operational_flag AND staff_rows.outcome = 'OPEN'
      )::int AS open_count,
      MAX(staff_rows.duration_seconds) FILTER (
        WHERE NOT staff_rows.operational_flag AND staff_rows.outcome = 'OPEN'
      )::int AS open_max_elapsed_seconds
    FROM staff_rows
    GROUP BY staff_rows.delay_type
  ) aggregate ON aggregate.delay_type = type_buckets.delay_type
), reason_buckets(reason_code, sort_order) AS (
  ${LATENESS_REASON_CODE_BUCKETS_SQL}
), by_reason AS (
  SELECT reason_buckets.reason_code, reason_buckets.sort_order,
    COALESCE(aggregate.incident_count, 0) AS incident_count
  FROM reason_buckets
  LEFT JOIN (
    SELECT staff_rows.operational_reason_code AS reason_code,
      COUNT(*)::int AS incident_count
    FROM staff_rows
    WHERE staff_rows.operational_flag
    GROUP BY staff_rows.operational_reason_code
  ) aggregate ON aggregate.reason_code = reason_buckets.reason_code
)
SELECT
  (SELECT COUNT(*) FROM staff_rows
    WHERE staff_rows.delay_type NOT IN ('LATE_START', 'LATE_SUBMISSION'))::int
    AS invalid_delay_type_count,
  (SELECT COUNT(DISTINCT staff_rows.job_card_id) FROM staff_rows
    WHERE NOT staff_rows.operational_flag)::int AS responsibility_delayed_job_count,
  (SELECT COUNT(*) FROM staff_rows
    WHERE NOT staff_rows.operational_flag)::int AS responsibility_incident_count,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'delayType', by_type.delay_type,
      'incidentCount', by_type.incident_count,
      'recovered', jsonb_build_object(
        'count', by_type.recovered_count,
        'medianSeconds', by_type.recovered_median_seconds,
        'maxSeconds', by_type.recovered_max_seconds),
      'extended', jsonb_build_object(
        'count', by_type.extended_count,
        'medianSeconds', by_type.extended_median_seconds,
        'maxSeconds', by_type.extended_max_seconds),
      'open', jsonb_build_object(
        'count', by_type.open_count,
        'maxElapsedSeconds', by_type.open_max_elapsed_seconds)
    ) ORDER BY by_type.sort_order), '[]'::jsonb) FROM by_type) AS by_type,
  (SELECT COUNT(DISTINCT staff_rows.job_card_id) FROM staff_rows
    WHERE staff_rows.operational_flag)::int AS operational_delayed_job_count,
  (SELECT COUNT(*) FROM staff_rows
    WHERE staff_rows.operational_flag)::int AS operational_incident_count,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'reasonCode', by_reason.reason_code,
      'incidentCount', by_reason.incident_count
    ) ORDER BY by_reason.incident_count DESC, by_reason.sort_order), '[]'::jsonb)
    FROM by_reason WHERE by_reason.incident_count > 0) AS by_reason`;

const ORGANIZATION_LATENESS_SUMMARY_SQL = (includeSaleCapability: boolean) => `WITH ${ORGANIZATION_RANGE_CTE},
${latenessCohortSql(includeSaleCapability)}
SELECT to_char(organization_range.from_date, 'YYYY-MM-DD') AS "from",
  to_char(organization_range.to_date, 'YYYY-MM-DD') AS "to",
  organization_range.timezone,
  aggregate.total_incident_count,
  aggregate.staff_responsibility_delayed_job_count,
  aggregate.staff_responsibility_incident_count,
  aggregate.operational_delayed_job_count,
  aggregate.operational_incident_count,
  aggregate.unknown_delayed_job_count,
  aggregate.unknown_incident_count,
  aggregate.management_delayed_job_count,
  aggregate.management_incident_count,
  aggregate.management_recovered,
  aggregate.management_open
FROM organization_range
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS total_incident_count,
    COUNT(DISTINCT flagged.job_card_id) FILTER (
      WHERE flagged.accountability = 'STAFF_PROVEN' AND NOT flagged.operational_flag
    )::int AS staff_responsibility_delayed_job_count,
    COUNT(*) FILTER (
      WHERE flagged.accountability = 'STAFF_PROVEN' AND NOT flagged.operational_flag
    )::int AS staff_responsibility_incident_count,
    COUNT(DISTINCT flagged.job_card_id) FILTER (
      WHERE flagged.accountability = 'STAFF_PROVEN' AND flagged.operational_flag
    )::int AS operational_delayed_job_count,
    COUNT(*) FILTER (
      WHERE flagged.accountability = 'STAFF_PROVEN' AND flagged.operational_flag
    )::int AS operational_incident_count,
    COUNT(DISTINCT flagged.job_card_id) FILTER (
      WHERE flagged.accountability = 'STAFF_UNKNOWN'
    )::int AS unknown_delayed_job_count,
    COUNT(*) FILTER (
      WHERE flagged.accountability = 'STAFF_UNKNOWN'
    )::int AS unknown_incident_count,
    COUNT(DISTINCT flagged.job_card_id) FILTER (
      WHERE flagged.accountability = 'MANAGEMENT'
    )::int AS management_delayed_job_count,
    COUNT(*) FILTER (
      WHERE flagged.accountability = 'MANAGEMENT'
    )::int AS management_incident_count,
    jsonb_build_object(
      'count', COUNT(*) FILTER (
        WHERE flagged.accountability = 'MANAGEMENT' AND flagged.outcome = 'RECOVERED'
      )::int,
      'medianSeconds', FLOOR(percentile_cont(0.5) WITHIN GROUP (
        ORDER BY flagged.duration_seconds
      ) FILTER (
        WHERE flagged.accountability = 'MANAGEMENT' AND flagged.outcome = 'RECOVERED'
      ))::int,
      'maxSeconds', MAX(flagged.duration_seconds) FILTER (
        WHERE flagged.accountability = 'MANAGEMENT' AND flagged.outcome = 'RECOVERED'
      )::int
    ) AS management_recovered,
    jsonb_build_object(
      'count', COUNT(*) FILTER (
        WHERE flagged.accountability = 'MANAGEMENT' AND flagged.outcome = 'OPEN'
      )::int,
      'maxElapsedSeconds', MAX(flagged.duration_seconds) FILTER (
        WHERE flagged.accountability = 'MANAGEMENT' AND flagged.outcome = 'OPEN'
      )::int
    ) AS management_open
  FROM flagged
) aggregate ON TRUE`;

/**
 * Staff scope (both groups). Bound parameters: $1 organization, $2 from,
 * $3 to, $4 requestTime, $5 staff user, $6 limit, $7 offset, $8 viewer role,
 * $9 viewer user. A Staff viewer sees a job row only while the job is
 * currently assigned to them; management always sees it.
 */
const STAFF_LATENESS_INCIDENTS_SQL = (includeSaleCapability: boolean) => `WITH ${ORGANIZATION_RANGE_CTE},
${latenessCohortSql(includeSaleCapability)},
scoped AS (
  SELECT flagged.* FROM flagged
  WHERE flagged.accountability = 'STAFF_PROVEN'
    AND flagged.accountable_user_id = $5::uuid
)
SELECT scoped.id AS incident_id,
  scoped.delay_type,
  scoped.episode_no,
  scoped.schedule_revision_no,
  scoped.deadline_at,
  scoped.breached_at,
  scoped.outcome,
  CASE
    WHEN scoped.outcome = 'RECOVERED' THEN scoped.recovered_at
    WHEN scoped.outcome = 'EXTENDED' THEN scoped.ended_at
    ELSE NULL
  END AS closed_at,
  scoped.duration_seconds,
  scoped.operational_reason_code,
  scoped.operational_resolution,
  scoped.operational_resolved_at,
  CASE
    WHEN $8::text = 'STAFF' AND jc.assigned_to IS DISTINCT FROM $9::uuid THEN NULL
    ELSE jsonb_build_object('id', jc.id, 'title', jc.title, 'type', jc.type)
  END AS job
FROM scoped
JOIN ${saleReadableJobsSql(includeSaleCapability)} jc
  ON jc.organization_id = $1 AND jc.id = scoped.job_card_id
ORDER BY scoped.breached_at DESC, scoped.id DESC
LIMIT $6 OFFSET $7`;

const STAFF_LATENESS_INCIDENT_COUNT_SQL = (includeSaleCapability: boolean) => `WITH ${ORGANIZATION_RANGE_CTE},
${latenessCohortSql(includeSaleCapability)},
scoped AS (
  SELECT flagged.id FROM flagged
  WHERE flagged.accountability = 'STAFF_PROVEN'
    AND flagged.accountable_user_id = $5::uuid
)
SELECT COUNT(*)::int AS total FROM scoped`;

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

const APPROVAL_SUMMARY_SQL = (includeSaleCapability: boolean) => `WITH waiting AS (
  SELECT GREATEST($2::timestamptz - j.staff_completed_at,
    interval '0 seconds') AS elapsed
  FROM ${saleReadableJobsSql(includeSaleCapability)} j
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
        AND ${OVERDUE_JOB_CARD_CLAUSE}
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
    COUNT(jc.id) FILTER (WHERE jc.type = 'SALE' AND jc.created_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
      AND jc.created_at < ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone))::int AS created_sale,
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

const CUSTOMER_REPORT_SQL = (includeSaleCapability: boolean) => `WITH ${ORGANIZATION_RANGE_CTE}, customer_scope AS (
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
  FROM ${saleReadableJobsSql(includeSaleCapability)} jc
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.status <> 'INVALIDATED'
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
  COALESCE(activity.created_sale, 0)::int AS created_sale,
  COALESCE(activity.manager_approved, 0)::int AS manager_approved,
  COALESCE(activity.follow_up_children, 0)::int AS follow_up_children
FROM customer_page
LEFT JOIN activity ON activity.customer_id = customer_page.id
ORDER BY customer_page.name COLLATE "C" ASC, customer_page.id ASC`;

const CUSTOMER_REPORT_UNASSIGNED_SQL = (includeSaleCapability: boolean) => `WITH ${ORGANIZATION_RANGE_CTE}
SELECT${CUSTOMER_REPORT_ACTIVITY_COLUMNS}
FROM ${saleReadableJobsSql(includeSaleCapability)} jc
CROSS JOIN organization_range
WHERE jc.organization_id = $1
  AND jc.status <> 'INVALIDATED'
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
const SALES_FOLLOW_UP_AGGREGATE_SQL = (includeSaleCapability: boolean) => `WITH ${ORGANIZATION_RANGE_CTE}, active_statuses(status, sort_order) AS (
  VALUES ${ACTIVE_STATUS_BUCKETS_SQL}
), work_types(type, sort_order) AS (
  VALUES ${workTypeBucketsSql(includeSaleCapability)}
), outcomes(outcome, sort_order) AS (
  VALUES
    ('POSITIVE', 1),
    ('FOLLOW_UP_REQUIRED', 2),
    ('NO_DECISION', 3),
    ('NOT_INTERESTED', 4)
), current_sales_meetings AS (
  SELECT jc.id
  FROM ${saleReadableJobsSql(includeSaleCapability)} jc
  WHERE jc.organization_id = $1
    AND jc.type = 'SALES_MEETING'
    AND jc.status IN (${ACTIVE_STATUS_LIST_SQL})
), follow_up_children AS (
  SELECT jc.id, jc.status, jc.type, jc.due_date, jc.customer_id,
    jc.created_at, parent.customer_id AS parent_customer_id
  FROM ${saleReadableJobsSql(includeSaleCapability)} jc
  JOIN ${saleReadableJobsSql(includeSaleCapability)} parent ON parent.organization_id = jc.organization_id
    AND parent.id = jc.source_job_card_id
  WHERE jc.organization_id = $1
    AND jc.source_job_card_id IS NOT NULL
    AND jc.status <> 'INVALIDATED'
    AND parent.status <> 'INVALIDATED'
), active_children AS (
  SELECT * FROM follow_up_children
  WHERE status IN (${ACTIVE_STATUS_LIST_SQL})
), sales_meeting_status_distribution AS (
  SELECT active_statuses.status, active_statuses.sort_order,
    COUNT(jc.id)::int AS count
  FROM active_statuses
  LEFT JOIN ${saleReadableJobsSql(includeSaleCapability)} jc ON jc.organization_id = $1
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
  JOIN ${saleReadableJobsSql(includeSaleCapability)} jc ON jc.organization_id = md.organization_id
    AND jc.id = md.job_card_id
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.type = 'SALES_MEETING'
    AND jc.status = 'COMPLETED'
    -- JOB-010 release 2a (D1 §4): a not-held visit has no meeting_at and is
    -- attributed to its completion instant, so the outcome distribution keeps
    -- it visible. The business-trend "visits" cohort still requires
    -- meeting_at: a visit that did not happen is not a visit.
    AND COALESCE(md.meeting_at, jc.staff_completed_at) >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND COALESCE(md.meeting_at, jc.staff_completed_at) <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
  GROUP BY md.outcome
), outcome_distribution AS (
  SELECT outcomes.outcome, outcomes.sort_order,
    COALESCE(outcome_counts.count, 0)::int AS count
  FROM outcomes
  LEFT JOIN outcome_counts ON outcome_counts.outcome = outcomes.outcome
), period_created AS (
  SELECT COUNT(jc.id)::int AS count
  FROM ${saleReadableJobsSql(includeSaleCapability)} jc
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.type = 'SALES_MEETING'
    AND jc.status <> 'INVALIDATED'
    AND jc.created_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.created_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
), period_manager_approved AS (
  SELECT COUNT(jc.id)::int AS count
  FROM ${saleReadableJobsSql(includeSaleCapability)} jc
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
  WHERE ${currentOverduePredicateSql({
    dueDate: 'children.due_date',
    timezone: 'organization_range.timezone',
    requestTime: '$4::timestamptz',
    status: 'children.status',
    jobType: 'children.type',
  })}
), divergence AS (
  SELECT COUNT(children.id)::int AS count
  FROM follow_up_children children
  WHERE children.parent_customer_id IS DISTINCT FROM children.customer_id
)
SELECT to_char(organization_range.from_date, 'YYYY-MM-DD') AS from_date,
  to_char(organization_range.to_date, 'YYYY-MM-DD') AS to_date,
  organization_range.timezone,
  (SELECT COUNT(*) FROM current_sales_meetings)::int AS current_sales_meetings_total,
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

const SALES_MEETING_QUEUE_SQL = (includeSaleCapability: boolean) => `SELECT jc.id, jc.status, jc.scheduled_at,
  c.id AS customer_id, c.name AS customer_name,
  u.id AS assignee_id, u.name AS assignee_name
FROM ${saleReadableJobsSql(includeSaleCapability)} jc
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

const SALES_MEETING_QUEUE_COUNT_SQL = (includeSaleCapability: boolean) => `SELECT COUNT(*)::int AS total
FROM ${saleReadableJobsSql(includeSaleCapability)} jc
WHERE jc.organization_id = $1
  AND jc.type = 'SALES_MEETING'
  AND jc.status IN (${ACTIVE_STATUS_LIST_SQL})`;

const PROPOSAL_QUEUE_PREDICATE = `jc.organization_id = $1
  AND jc.type = 'SALES_MEETING'
  AND jc.follow_up_proposed_at IS NOT NULL
  AND jc.status IN ('WAITING_APPROVAL', 'REVISION_REQUESTED')`;

const PROPOSAL_QUEUE_SQL = (includeSaleCapability: boolean) => `SELECT jc.id, jc.status, jc.follow_up_proposed_at,
  jc.follow_up_proposed_type, jc.follow_up_proposal_instructions,
  jc.follow_up_proposal_origin,
  c.id AS customer_id, c.name AS customer_name,
  u.id AS assignee_id, u.name AS assignee_name,
  pu.id AS proposed_assignee_id, pu.name AS proposed_assignee_name
FROM ${saleReadableJobsSql(includeSaleCapability)} jc
JOIN users u ON u.organization_id = jc.organization_id
  AND u.id = jc.assigned_to
LEFT JOIN customers c ON c.organization_id = jc.organization_id
  AND c.id = jc.customer_id
LEFT JOIN users pu ON pu.organization_id = jc.organization_id
  AND pu.id = jc.follow_up_proposed_assignee
WHERE ${PROPOSAL_QUEUE_PREDICATE}
ORDER BY jc.follow_up_proposed_at ASC NULLS LAST, jc.id ASC
LIMIT $2
OFFSET $3`;

const PROPOSAL_QUEUE_COUNT_SQL = (includeSaleCapability: boolean) => `SELECT COUNT(*)::int AS total
FROM ${saleReadableJobsSql(includeSaleCapability)} jc
WHERE ${PROPOSAL_QUEUE_PREDICATE}`;

function deliveryGroupedSql(
  input: DeliveryReportReadInput,
  definition: DeliveryGroupDefinition,
) {
  const staffJoins = input.groupBy === 'staff'
    ? `
JOIN users u ON u.organization_id = jc.organization_id
  AND u.id = jc.staff_completed_by AND u.role = 'STAFF'
JOIN staff_profiles sp ON sp.organization_id = u.organization_id
  AND sp.user_id = u.id`
    : '';
  const staffFilter = input.staffUserId === null
    ? ''
    : '\n  AND jc.staff_completed_by = $5';

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
  created_sale: string | number;
  manager_approved: string | number;
  follow_up_children: string | number;
}, includeSaleCapability = true): CustomerReportActivity {
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
        ...(includeSaleCapability ? { SALE: Number(row.created_sale) } : {}),
      },
      managerApproved: Number(row.manager_approved),
      followUpChildren: Number(row.follow_up_children),
    },
  };
}

function mapCustomerReportItem(row: CustomerReportRow, includeSaleCapability = true): CustomerReportItem {
  return {
    customer: {
      id: row.id,
      name: row.name,
      customerType: row.customer_type as CustomerReportItem['customer']['customerType'],
      status: row.status as CustomerReportItem['customer']['status'],
    },
    activity: mapCustomerReportActivity(row, includeSaleCapability),
  };
}

function mapCustomerReportUnassigned(row: CustomerReportUnassignedRow, includeSaleCapability = true): CustomerReportUnassigned {
  return { ...mapCustomerReportActivity(row, includeSaleCapability) };
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

function nullableNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function mapLatenessDurationStats(input: LatenessDurationJson): LatenessDurationStats {
  return {
    count: Number(input.count),
    medianSeconds: nullableNumber(input.medianSeconds),
    maxSeconds: nullableNumber(input.maxSeconds),
  };
}

function mapLatenessOpenStats(
  input: { count: string | number; maxElapsedSeconds: string | number | null },
): LatenessOpenStats {
  return {
    count: Number(input.count),
    maxElapsedSeconds: nullableNumber(input.maxElapsedSeconds),
  };
}

function mapStaffLatenessSummary(row: StaffLatenessSummaryRow): StaffLatenessAggregate {
  return {
    staffResponsibility: {
      delayedJobCount: Number(row.responsibility_delayed_job_count),
      incidentCount: Number(row.responsibility_incident_count),
      byType: row.by_type.map((type) => ({
        delayType: type.delayType,
        incidentCount: Number(type.incidentCount),
        recovered: mapLatenessDurationStats(type.recovered),
        extended: mapLatenessDurationStats(type.extended),
        open: mapLatenessOpenStats(type.open),
      })),
    },
    operational: {
      delayedJobCount: Number(row.operational_delayed_job_count),
      incidentCount: Number(row.operational_incident_count),
      byReason: row.by_reason.map((reason) => ({
        reasonCode: reason.reasonCode,
        incidentCount: Number(reason.incidentCount),
      })),
    },
  };
}

function mapOrganizationLatenessSummary(
  row: OrganizationLatenessSummaryRow,
): OrganizationLatenessAggregate {
  return {
    range: {
      from: row.from,
      to: row.to,
      timezone: row.timezone,
    },
    totalIncidentCount: Number(row.total_incident_count),
    staffResponsibility: {
      delayedJobCount: Number(row.staff_responsibility_delayed_job_count),
      incidentCount: Number(row.staff_responsibility_incident_count),
    },
    operational: {
      delayedJobCount: Number(row.operational_delayed_job_count),
      incidentCount: Number(row.operational_incident_count),
    },
    unknownAccountability: {
      delayedJobCount: Number(row.unknown_delayed_job_count),
      incidentCount: Number(row.unknown_incident_count),
    },
    managementApprovalWait: {
      delayedJobCount: Number(row.management_delayed_job_count),
      incidentCount: Number(row.management_incident_count),
      recovered: mapLatenessDurationStats(row.management_recovered),
      open: mapLatenessOpenStats(row.management_open),
    },
  };
}

function mapLatenessIncident(row: LatenessIncidentRow): StaffLatenessIncidentItem {
  if (row.delay_type !== 'LATE_START' && row.delay_type !== 'LATE_SUBMISSION') {
    throw new Error('Staff lateness incident delay type invariant could not be resolved.');
  }
  return {
    incidentId: row.incident_id,
    delayType: row.delay_type,
    episodeNo: Number(row.episode_no),
    scheduleRevisionNo: Number(row.schedule_revision_no),
    deadlineAt: row.deadline_at.toISOString(),
    breachedAt: row.breached_at.toISOString(),
    outcome: row.outcome,
    closedAt: row.closed_at === null ? null : row.closed_at.toISOString(),
    durationSeconds: Number(row.duration_seconds),
    operationalReason: row.operational_reason_code !== null
      && row.operational_resolution !== null
      && row.operational_resolved_at !== null
      ? {
          reasonCode: row.operational_reason_code,
          resolution: row.operational_resolution,
          resolvedAt: row.operational_resolved_at.toISOString(),
        }
      : null,
    job: row.job === null
      ? null
      : { ...row.job, jobPath: `/jobs/${row.job.id}` },
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
    weeklyReportWorkload: Number(row.weekly_report_workload),
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

class PostgresReportsReadModel implements ReportsReadModel {
  constructor(private readonly executor: SqlExecutor) {}

  getBusinessTrend(input: StaffOperationalSummaryScope) {
    return readBusinessTrend(this.executor, input);
  }

  async getOne(input: StaffOperationalSummaryOneInput) {
    const summaries = await this.getMany({
      organizationId: input.organizationId,
      staffUserIds: [input.staffUserId],
      requestedRange: input.requestedRange,
      ...(input.includeSaleCapability !== undefined ? { includeSaleCapability: input.includeSaleCapability } : {}),
      requestTime: input.requestTime,
    });
    return summaries.get(input.staffUserId) ?? null;
  }

  async getMany(input: StaffOperationalSummaryManyInput) {
    const staffUserIds = [...new Set(input.staffUserIds)];
    if (staffUserIds.length === 0) {
      return new Map<string, StaffOperationalSummary>();
    }
    const result = await this.executor.query<StaffSummaryRow>(STAFF_SUMMARY_SQL(input.includeSaleCapability !== false), [
      input.organizationId,
      input.requestedRange?.from ?? null,
      input.requestedRange?.to ?? null,
      input.requestTime,
      staffUserIds,
    ]);
    return new Map(result.rows.map((row) => [row.staff_user_id, mapStaffSummary(row)]));
  }

  async getDashboard(input: StaffOperationalSummaryScope) {
    const result = await this.executor.query<DashboardRow>(DASHBOARD_SQL(input.includeSaleCapability !== false), [
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
    const result = await this.executor.query<StaffPerformanceScopeRow>(
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
    const result = await this.executor.query<StaffCompletionPerformanceRow>(
      STAFF_COMPLETION_PERFORMANCE_SQL(input.includeSaleCapability !== false),
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
    const result = await this.executor.query<StaffExecutionRow>(STAFF_EXECUTION_SQL(input.includeSaleCapability !== false), [
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
    const result = await this.executor.query<StaffOnTimeRow>(STAFF_ON_TIME_SQL(input.includeSaleCapability !== false), [
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
    return this.getStaffGroupedCounts(STAFF_CORRECTION_EVENTS_SQL(input.includeSaleCapability !== false), input);
  }

  async getStaffAuthoredOperationalNotesMany(
    input: StaffOperationalSummaryManyInput,
  ): Promise<ReadonlyMap<string, number>> {
    return this.getStaffGroupedCounts(STAFF_AUTHORED_OPERATIONAL_NOTES_SQL(input.includeSaleCapability !== false), input);
  }

  async getStaffDailyCompletionTrend(input: StaffOperationalSummaryOneInput) {
    const result = await this.executor.query<DailyCompletionRow>(
      STAFF_DAILY_COMPLETION_TREND_SQL(input.includeSaleCapability !== false),
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
    const result = await this.executor.query<StaffIdentityRow>(STAFF_IDENTITY_SQL, [
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

  async getStaffLatenessSummary(
    input: StaffOperationalSummaryOneInput,
  ): Promise<StaffLatenessAggregate> {
    const result = await this.executor.query<StaffLatenessSummaryRow>(
      STAFF_LATENESS_SUMMARY_SQL(input.includeSaleCapability !== false),
      [
        input.organizationId,
        input.requestedRange?.from ?? null,
        input.requestedRange?.to ?? null,
        input.requestTime,
        input.staffUserId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Staff lateness summary could not be resolved.');
    // Contract §4.1: the producer never writes a STAFF_PROVEN row of another
    // delay type; if one exists the read fails closed instead of hiding it.
    if (Number(row.invalid_delay_type_count) !== 0) {
      throw new Error('Staff lateness delay type invariant could not be resolved.');
    }
    return mapStaffLatenessSummary(row);
  }

  async getOrganizationLatenessSummary(
    input: StaffOperationalSummaryScope,
  ): Promise<OrganizationLatenessAggregate> {
    const result = await this.executor.query<OrganizationLatenessSummaryRow>(
      ORGANIZATION_LATENESS_SUMMARY_SQL(input.includeSaleCapability !== false),
      [
        input.organizationId,
        input.requestedRange?.from ?? null,
        input.requestedRange?.to ?? null,
        input.requestTime,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Organization lateness summary could not be resolved.');
    return mapOrganizationLatenessSummary(row);
  }

  async listStaffLatenessIncidents(
    input: StaffLatenessIncidentListInput,
  ): Promise<StaffLatenessIncidentListResponse> {
    const rangeValues = [
      input.organizationId,
      input.requestedRange?.from ?? null,
      input.requestedRange?.to ?? null,
      input.requestTime,
    ];
    const scopeValues = [...rangeValues, input.staffUserId];
    const rangeResult = await this.executor.query<ResolvedReportRangeRow>(
      RESOLVED_REPORT_RANGE_SQL,
      rangeValues,
    );
    const resolvedRange = rangeResult.rows[0];
    if (!resolvedRange) {
      throw new Error('Staff lateness incident organization range could not be resolved.');
    }
    const [countResult, pageResult] = await Promise.all([
      this.executor.query<{ total: string | number }>(
        STAFF_LATENESS_INCIDENT_COUNT_SQL(input.includeSaleCapability !== false),
        scopeValues,
      ),
      this.executor.query<LatenessIncidentRow>(
        STAFF_LATENESS_INCIDENTS_SQL(input.includeSaleCapability !== false),
        [...scopeValues, input.limit, input.offset, input.viewer.role, input.viewer.userId],
      ),
    ]);
    return {
      range: resolvedRange,
      items: pageResult.rows.map(mapLatenessIncident),
      total: Number(countResult.rows[0]?.total ?? 0),
      limit: input.limit,
      offset: input.offset,
    };
  }

  async getStaffDeliveriesByPurpose(
    input: StaffOperationalSummaryOneInput,
  ): Promise<DeliveryPurposeItem[]> {
    const result = await this.executor.query<DeliveryPurposeRow>(
      STAFF_DELIVERIES_BY_PURPOSE_SQL(input.includeSaleCapability !== false),
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
    const result = await this.executor.query<MeetingOutcomeRow>(
      STAFF_MEETINGS_BY_OUTCOME_SQL(input.includeSaleCapability !== false),
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

    const rangeResult = await this.executor.query<ResolvedReportRangeRow>(
      RESOLVED_REPORT_RANGE_SQL,
      rangeValues,
    );
    const resolvedRange = rangeResult.rows[0];
    if (!resolvedRange) {
      throw new Error('Delivery report organization range could not be resolved.');
    }

    const [countResult, pageResult] = await Promise.all([
      this.executor.query<{ total: number }>(countSql, groupedValues),
      this.executor.query<DeliveryGroupRow>(
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
    includeSaleCapability?: boolean;
  }): Promise<ApprovalSummary> {
    const result = await this.executor.query<ApprovalSummaryRow>(APPROVAL_SUMMARY_SQL(input.includeSaleCapability !== false), [
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
    const result = await this.executor.query<{ type: string; count: string }>(
      `SELECT j.type, COUNT(*)::int AS count
        FROM ${saleReadableJobsSql(input.includeSaleCapability !== false)} j
         JOIN organizations o ON o.id = j.organization_id
        WHERE j.organization_id = $1
          AND j.status <> 'INVALIDATED'
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
    const rangeResult = await this.executor.query<ResolvedReportRangeRow>(
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
      this.executor.query<{ total: string | number }>(CUSTOMER_REPORT_COUNT_SQL, [
        input.organizationId,
        searchPattern,
        input.status,
        input.customerType,
      ]),
      this.executor.query<CustomerReportRow>(CUSTOMER_REPORT_SQL(input.includeSaleCapability !== false), [
        ...rangeValues,
        searchPattern,
        input.status,
        input.customerType,
        input.limit,
        input.offset,
      ]),
      this.executor.query<CustomerReportUnassignedRow>(CUSTOMER_REPORT_UNASSIGNED_SQL(input.includeSaleCapability !== false), rangeValues),
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
      items: pageResult.rows.map((row) => mapCustomerReportItem(row, input.includeSaleCapability !== false)),
      unassigned: mapCustomerReportUnassigned(unassignedRow, input.includeSaleCapability !== false),
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
    const rangeResult = await this.executor.query<ResolvedReportRangeRow>(
      RESOLVED_REPORT_RANGE_SQL,
      rangeValues,
    );
    const resolvedRange = rangeResult.rows[0];
    if (!resolvedRange) {
      throw new Error('Sales follow-up report organization range could not be resolved.');
    }
    const [aggregateResult, queueCountResult, queuePageResult, proposalCountResult,
      proposalQueueResult]
      = await Promise.all([
        this.executor.query<SalesFollowUpAggregateRow>(
          SALES_FOLLOW_UP_AGGREGATE_SQL(input.includeSaleCapability !== false),
          rangeValues,
        ),
        this.executor.query<{ total: string | number }>(SALES_MEETING_QUEUE_COUNT_SQL(input.includeSaleCapability !== false), [
          input.organizationId,
        ]),
        this.executor.query<SalesMeetingQueueRow>(SALES_MEETING_QUEUE_SQL(input.includeSaleCapability !== false), [
          input.organizationId,
          input.limit,
          input.offset,
        ]),
        this.executor.query<{ total: string | number }>(PROPOSAL_QUEUE_COUNT_SQL(input.includeSaleCapability !== false), [
          input.organizationId,
        ]),
        this.executor.query<ProposalQueueRow>(PROPOSAL_QUEUE_SQL(input.includeSaleCapability !== false), [
          input.organizationId,
          input.proposalLimit,
          input.proposalOffset,
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
    const proposalCountRow = proposalCountResult.rows[0];
    if (!proposalCountRow) {
      throw new Error('Sales follow-up proposal queue count could not be resolved.');
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
          total: Number(proposalCountRow.total),
          limit: input.proposalLimit,
          offset: input.proposalOffset,
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
    const result = await this.executor.query<StaffCountRow>(sql, [
      input.organizationId,
      input.requestedRange?.from ?? null,
      input.requestedRange?.to ?? null,
      input.requestTime,
      staffUserIds,
    ]);
    return new Map(result.rows.map((row) => [row.staff_user_id, Number(row.count)]));
  }
}

/** Binds the reports read model to one executor (pool or checked-out client). */
export function createReportsReadModel(executor: SqlExecutor): ReportsReadModel {
  return new PostgresReportsReadModel(executor);
}

/**
 * Pool-backed reports read model. Each method issues its own pooled statement;
 * wrap a multi-read composition in a report read snapshot to pin one MVCC
 * snapshot for the whole response.
 */
export class PostgresReportsRepository extends PostgresReportsReadModel {
  constructor(pool: Pool) {
    super(pool);
  }
}
