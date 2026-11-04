import type { SqlExecutor } from '../../db/executor.js';
import { ORGANIZATION_RANGE_CTE } from './range-sql.js';
import type { BusinessTrendReportResponse, StaffOperationalSummaryScope } from './types.js';

// One statement: series, comparison and explicit relationships see the same
// committed state. Actual meeting/agreement times, never creation or delivery.
const SQL = `WITH ${ORGANIZATION_RANGE_CTE}, observed AS (
  SELECT *, LEAST(to_date, ($4::timestamptz AT TIME ZONE timezone)::date) AS observed_to,
    from_date::timestamp AT TIME ZONE timezone AS starts_at,
    LEAST((to_date + 1)::timestamp AT TIME ZONE timezone, $4::timestamptz) AS ends_at,
    from_date <= ($4::timestamptz AT TIME ZONE timezone)::date
      AND to_date >= ($4::timestamptz AT TIME ZONE timezone)::date AS partial_day
  FROM organization_range
), bounds AS (
  SELECT *, from_date - (observed_to - from_date + 1) AS prior_from,
    from_date - 1 AS prior_to,
    (from_date - (observed_to - from_date + 1))::timestamp AT TIME ZONE timezone AS prior_starts_at,
    CASE WHEN partial_day THEN
      ((from_date - 1) + ($4::timestamptz AT TIME ZONE timezone)::time) AT TIME ZONE timezone
      ELSE from_date::timestamp AT TIME ZONE timezone END AS prior_ends_at
  FROM observed
), visits AS (
  SELECT j.id, j.customer_id, j.source_job_card_id, d.meeting_at AS occurred_at
  FROM job_cards j
  JOIN job_card_meeting_details d ON d.job_card_id = j.id AND d.organization_id = j.organization_id
  WHERE j.organization_id = $1 AND j.type = 'SALES_MEETING' AND j.status = 'COMPLETED'
    AND j.manager_approved_at <= $4::timestamptz AND d.meeting_at <= $4::timestamptz
), sales AS (
  SELECT j.id, j.customer_id, j.sale_source_visit_id, d.sold_at AS occurred_at
  FROM job_cards j
  JOIN job_card_sale_details d ON d.job_card_id = j.id AND d.organization_id = j.organization_id
  WHERE j.organization_id = $1 AND j.type = 'SALE' AND j.status = 'COMPLETED'
    AND $5::boolean AND j.manager_approved_at <= $4::timestamptz AND d.sold_at <= $4::timestamptz
), events AS (
  SELECT occurred_at, 1 AS visits, (source_job_card_id IS NOT NULL)::int AS follow_ups, 0 AS sales FROM visits
  UNION ALL
  SELECT occurred_at, 0, 0, 1 FROM sales
), current_events AS (
  SELECT e.* FROM events e CROSS JOIN bounds b
  WHERE e.occurred_at >= b.starts_at AND e.occurred_at < b.ends_at
), prior_events AS (
  SELECT e.* FROM events e CROSS JOIN bounds b
  WHERE b.from_date <= b.observed_to
    AND e.occurred_at >= b.prior_starts_at AND e.occurred_at < b.prior_ends_at
), daily AS (
  SELECT (e.occurred_at AT TIME ZONE b.timezone)::date AS day,
    sum(e.visits)::int AS visits, sum(e.follow_ups)::int AS follow_ups, sum(e.sales)::int AS sales
  FROM current_events e CROSS JOIN bounds b GROUP BY 1
), cohort AS (
  SELECT v.*,
    EXISTS (SELECT 1 FROM visits child WHERE child.source_job_card_id = v.id
      AND child.customer_id = v.customer_id) AS has_follow_up,
    EXISTS (SELECT 1 FROM sales s WHERE s.sale_source_visit_id = v.id
      AND s.customer_id = v.customer_id) AS has_sale
  FROM visits v CROSS JOIN bounds b
  WHERE v.occurred_at >= b.starts_at AND v.occurred_at < b.ends_at
)
SELECT jsonb_build_object(
  'range', jsonb_build_object('from', b.from_date::text, 'to', b.to_date::text, 'timezone', b.timezone),
  'asOf', $4::timestamptz,
  'observedThrough', CASE WHEN b.from_date <= b.observed_to THEN b.observed_to::text ELSE NULL END,
  'partialDay', b.partial_day,
  'totals', (SELECT jsonb_build_object('visits', COALESCE(sum(visits),0)::int,
    'followUps', COALESCE(sum(follow_ups),0)::int, 'sales', COALESCE(sum(sales),0)::int) FROM current_events),
  'points', COALESCE((SELECT jsonb_agg(jsonb_build_object('date', day::date::text,
    'visits', COALESCE(d.visits,0), 'followUps', COALESCE(d.follow_ups,0), 'sales', COALESCE(d.sales,0)) ORDER BY day)
    FROM generate_series(0, b.observed_to - b.from_date) i
    CROSS JOIN LATERAL (SELECT b.from_date + i AS day) dates
    LEFT JOIN daily d USING (day)), '[]'::jsonb),
  'comparison', CASE WHEN b.from_date <= b.observed_to THEN jsonb_build_object(
    'range', jsonb_build_object('from', b.prior_from::text, 'to', b.prior_to::text, 'timezone', b.timezone),
    'totals', (SELECT jsonb_build_object('visits', COALESCE(sum(visits),0)::int,
      'followUps', COALESCE(sum(follow_ups),0)::int, 'sales', COALESCE(sum(sales),0)::int) FROM prior_events)
  ) ELSE NULL END,
  'relationships', (SELECT jsonb_build_object(
    'visitsWithFollowUp', count(*) FILTER (WHERE has_follow_up)::int,
    'visitsWithSale', count(*) FILTER (WHERE has_sale)::int,
    'followUpsWithSale', count(*) FILTER (WHERE source_job_card_id IS NOT NULL AND has_sale)::int
  ) FROM cohort)
) AS report FROM bounds b`;

export async function readBusinessTrend(executor: SqlExecutor, input: StaffOperationalSummaryScope) {
  const result = await executor.query<{ report: BusinessTrendReportResponse }>(SQL, [
    input.organizationId, input.requestedRange?.from ?? null, input.requestedRange?.to ?? null,
    input.requestTime, input.includeSaleCapability !== false,
  ]);
  const report = result.rows[0]?.report;
  if (!report) throw new Error('Business trend organization range could not be resolved.');
  return report;
}
