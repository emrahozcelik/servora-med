/** Shared organization-local date resolution for report read models. */
export const ORGANIZATION_RANGE_CTE = `organization_range AS (
  SELECT o.timezone,
    COALESCE($2::date,
      date_trunc('month', $4::timestamptz AT TIME ZONE o.timezone)::date) AS from_date,
    COALESCE($3::date,
      (date_trunc('month', $4::timestamptz AT TIME ZONE o.timezone)
        + interval '1 month - 1 day')::date) AS to_date
  FROM organizations o
  WHERE o.id = $1
)`;
