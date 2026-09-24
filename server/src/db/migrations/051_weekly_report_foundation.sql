-- 051: WEEKLY_REPORT server foundation (V1 Slice 1).
--
-- Establishes persistence for Weekly Reports WITHOUT enabling any public
-- creation workflow:
--   * `job_cards.type` accepts the new `WEEKLY_REPORT` literal (schema
--     support only; public create parsers keep rejecting it until Slice 2);
--   * `weekly_reports` holds report identity (Monday-Sunday period), the
--     mutable draft body, and frozen manager-question definitions;
--   * `weekly_report_submissions` holds append-only immutable submission
--     snapshots (one row per submit/resubmit; never updated).
--
-- No backfill: historical GENERAL_TASK records previously used as weekly
-- reports remain historical generic tasks and are never reinterpreted.
-- Both new tables start empty by construction.

ALTER TABLE job_cards
  DROP CONSTRAINT job_cards_type_check,
  ADD CONSTRAINT job_cards_type_check CHECK (type IN (
    'PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING', 'WEEKLY_REPORT'
  ));

-- One canonical WeeklyReport per (organization, staff, period_start).
-- The draft body stays editable (optimistic `version`); question definitions
-- are frozen at creation (managers use notes for later clarification).
CREATE TABLE weekly_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID NOT NULL,
  staff_user_id UUID NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  draft_summary TEXT NULL,
  draft_blockers TEXT NULL,
  draft_next_week_plan TEXT NULL,
  draft_highlights TEXT NULL,
  draft_field_observations TEXT NULL,
  draft_support_needed TEXT NULL,
  manager_questions JSONB NOT NULL DEFAULT '[]',
  manager_answers JSONB NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  -- One-to-one with the owning JobCard.
  UNIQUE (organization_id, job_card_id),
  -- V1 invariant: exactly one canonical report per staff/week, regardless of
  -- JobCard lifecycle status. No lifecycle predicate.
  UNIQUE (organization_id, staff_user_id, period_start),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, staff_user_id)
    REFERENCES users (organization_id, id),
  -- Monday-Sunday week: period_end is deterministically start + 6 days and
  -- period_start is an ISO Monday.
  CONSTRAINT weekly_reports_period_end_check
    CHECK (period_end = period_start + 6),
  CONSTRAINT weekly_reports_period_monday_check
    CHECK (EXTRACT(ISODOW FROM period_start) = 1),
  -- Draft safety bounds mirror the application 4000 code-point limit.
  CONSTRAINT weekly_reports_draft_summary_check
    CHECK (draft_summary IS NULL OR char_length(draft_summary) <= 4000),
  CONSTRAINT weekly_reports_draft_blockers_check
    CHECK (draft_blockers IS NULL OR char_length(draft_blockers) <= 4000),
  CONSTRAINT weekly_reports_draft_next_week_plan_check
    CHECK (draft_next_week_plan IS NULL OR char_length(draft_next_week_plan) <= 4000),
  CONSTRAINT weekly_reports_draft_highlights_check
    CHECK (draft_highlights IS NULL OR char_length(draft_highlights) <= 4000),
  CONSTRAINT weekly_reports_draft_field_observations_check
    CHECK (draft_field_observations IS NULL OR char_length(draft_field_observations) <= 4000),
  CONSTRAINT weekly_reports_draft_support_needed_check
    CHECK (draft_support_needed IS NULL OR char_length(draft_support_needed) <= 4000),
  CONSTRAINT weekly_reports_questions_check
    CHECK (jsonb_typeof(manager_questions) = 'array'),
  CONSTRAINT weekly_reports_answers_check
    CHECK (jsonb_typeof(manager_answers) = 'array')
);

CREATE INDEX weekly_reports_staff_period_idx
  ON weekly_reports (organization_id, staff_user_id, period_start);

-- Append-only submission history. Each submit/resubmit appends seq_no + 1
-- freezing the draft body, Q&A payload and source-work snapshot exactly as
-- submitted. Application discipline (same convention as the Foundation
-- history tables): no UPDATE or DELETE path exists for submission content.
CREATE TABLE weekly_report_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  weekly_report_id UUID NOT NULL,
  job_card_id UUID NOT NULL,
  seq_no INTEGER NOT NULL CHECK (seq_no >= 1),
  submitted_by UUID NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  frozen_body JSONB NOT NULL,
  frozen_questions JSONB NOT NULL,
  frozen_answers JSONB NOT NULL,
  frozen_source_work JSONB NOT NULL DEFAULT '[]',
  job_version INTEGER NOT NULL CHECK (job_version >= 1),
  source_activity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, weekly_report_id, seq_no),
  FOREIGN KEY (organization_id, weekly_report_id)
    REFERENCES weekly_reports (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, submitted_by)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, job_card_id, source_activity_id)
    REFERENCES job_card_activity_logs (organization_id, job_card_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT weekly_report_submissions_period_check
    CHECK (
      period_end = period_start + 6
      AND EXTRACT(ISODOW FROM period_start) = 1
    ),
  CONSTRAINT weekly_report_submissions_body_check
    CHECK (jsonb_typeof(frozen_body) = 'object'),
  CONSTRAINT weekly_report_submissions_questions_check
    CHECK (jsonb_typeof(frozen_questions) = 'array'),
  CONSTRAINT weekly_report_submissions_answers_check
    CHECK (jsonb_typeof(frozen_answers) = 'array'),
  CONSTRAINT weekly_report_submissions_source_work_check
    CHECK (jsonb_typeof(frozen_source_work) = 'array')
);

CREATE INDEX weekly_report_submissions_report_seq_idx
  ON weekly_report_submissions (organization_id, weekly_report_id, seq_no);

-- Fail closed if the type contract did not actually widen: a partial
-- application must abort instead of leaving a foundation that cannot persist
-- weekly reports.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_cards'::regclass
       AND conname = 'job_cards_type_check'
       AND pg_get_constraintdef(oid) LIKE '%WEEKLY_REPORT%'
  ) THEN
    RAISE EXCEPTION 'job_cards type CHECK must accept WEEKLY_REPORT';
  END IF;
END
$$;
