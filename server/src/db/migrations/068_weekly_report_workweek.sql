-- WR-WEEK: Weekly Report workweek period (Monday-Friday) and submission-period
-- agreement. Accepted contract: DECISIONS.md WR-WEEK and
-- docs/features/weekly-report-workweek.md (§3).
--
-- Widens weekly_reports and weekly_report_submissions period CHECKs so both
-- new 5-day workweek reports (period_end = period_start + 4) and historical
-- 7-day calendar-week reports (period_end = period_start + 6) are valid, and
-- binds each submission's period to its owning report via a composite foreign
-- key. No existing rows are rewritten or backfilled.

ALTER TABLE weekly_reports
  DROP CONSTRAINT weekly_reports_period_end_check,
  ADD CONSTRAINT weekly_reports_period_end_check
    CHECK (period_end = period_start + 4 OR period_end = period_start + 6),
  ADD CONSTRAINT weekly_reports_period_identity_key
    UNIQUE (organization_id, id, period_start, period_end);

ALTER TABLE weekly_report_submissions
  DROP CONSTRAINT weekly_report_submissions_period_check,
  ADD CONSTRAINT weekly_report_submissions_period_check
    CHECK (
      EXTRACT(ISODOW FROM period_start) = 1
      AND (period_end = period_start + 4 OR period_end = period_start + 6)
    ),
  ADD CONSTRAINT weekly_report_submissions_report_period_fk
    FOREIGN KEY (organization_id, weekly_report_id, period_start, period_end)
    REFERENCES weekly_reports (organization_id, id, period_start, period_end)
    ON DELETE RESTRICT;

-- Fail closed: every widened CHECK, the report period identity key and the
-- submission/report composite FK must be present with their accepted definitions.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_reports'::regclass
       AND conname = 'weekly_reports_period_end_check'
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%period_start + 4%'
       AND pg_get_constraintdef(oid) LIKE '%period_start + 6%'
  ) THEN
    RAISE EXCEPTION 'weekly_reports_period_end_check must accept + 4 or + 6';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_reports'::regclass
       AND conname = 'weekly_reports_period_monday_check'
       AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'weekly_reports_period_monday_check must remain present';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_report_submissions'::regclass
       AND conname = 'weekly_report_submissions_period_check'
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%isodow%'
       AND pg_get_constraintdef(oid) LIKE '%period_start + 4%'
       AND pg_get_constraintdef(oid) LIKE '%period_start + 6%'
  ) THEN
    RAISE EXCEPTION 'weekly_report_submissions_period_check must bind ISODOW=1 and + 4 or + 6';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_reports'::regclass
       AND conname = 'weekly_reports_period_identity_key'
       AND contype = 'u'
       AND pg_get_constraintdef(oid) LIKE '%(organization_id, id, period_start, period_end)%'
  ) THEN
    RAISE EXCEPTION 'weekly_reports must expose UNIQUE (organization_id, id, period_start, period_end)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_report_submissions'::regclass
       AND conname = 'weekly_report_submissions_report_period_fk'
       AND contype = 'f'
       AND confdeltype = 'r'
       AND pg_get_constraintdef(oid) LIKE '%(organization_id, weekly_report_id, period_start, period_end)%'
       AND pg_get_constraintdef(oid) LIKE '%REFERENCES weekly_reports(organization_id, id, period_start, period_end)%'
  ) THEN
    RAISE EXCEPTION 'weekly_report_submissions must bind its period to weekly_reports ON DELETE RESTRICT';
  END IF;
END
$$;
