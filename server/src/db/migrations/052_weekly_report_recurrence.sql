-- 052: WEEKLY_REPORT recurrence (V1 Slice 5, final slice).
--
-- Durable manager authorization: "for this STAFF member, request a new
-- WeeklyReport every week using this template".
--
-- Additive only. No existing WeeklyReport, JobCard or submission row is
-- altered, and nothing is backfilled: the table starts empty by construction,
-- so a deployed-but-unused migration is a no-op until a manager configures a
-- rule.
--
-- One canonical recurrence per (organization_id, staff_user_id). Bulk creation
-- produces N INDEPENDENT rows — there is deliberately no multi-assignee rule.
--
-- Frequency is fixed WEEKLY in V1: the domain identity of a due period is an
-- organization-local Monday stored as a DATE (`next_period_start`), never a
-- "Monday midnight UTC" instant. Organization timezone remains the single
-- authority for what "this week" means; due discovery converts the worker
-- instant into the organization's local calendar date at query time.

CREATE TABLE weekly_report_recurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  staff_user_id UUID NOT NULL,
  -- Durable authorization: the last MANAGER/ADMIN who created, edited or
  -- resumed this rule. It is retained as a real user identity so generated
  -- JobCards/activities have an accountable creator without inventing a
  -- system user and without re-running HTTP authorization on every tick.
  requested_by_user_id UUID NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- 'MANUAL' (manager paused) or 'STAFF_INELIGIBLE' (worker auto-paused).
  -- NULL exactly when the rule is enabled.
  disabled_reason VARCHAR(32) NULL,
  -- Organization-local Monday. The next period the rule is authorized to
  -- request. Advanced by exactly +7 days per processed occurrence.
  next_period_start DATE NOT NULL,
  manager_questions JSONB NOT NULL DEFAULT '[]',
  instructions TEXT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  -- Worker lease. Internal operational state, never exposed by the API.
  lease_token UUID NULL,
  lease_until TIMESTAMPTZ NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error_code VARCHAR(64) NULL,
  last_processed_period_start DATE NULL,
  last_outcome VARCHAR(16) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Tenant-scoped identity, matching the convention used by every other
  -- tenant-owned table (composite FKs, never a bare id reference).
  UNIQUE (organization_id, id),
  -- The product invariant: at most one rule per staff member.
  UNIQUE (organization_id, staff_user_id),
  CONSTRAINT weekly_report_recurrences_staff_user_fk
    FOREIGN KEY (organization_id, staff_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT weekly_report_recurrences_requested_by_user_fk
    FOREIGN KEY (organization_id, requested_by_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT weekly_report_recurrences_version_check
    CHECK (version >= 1),
  CONSTRAINT weekly_report_recurrences_failure_count_check
    CHECK (failure_count >= 0),
  -- The domain identity of a period is an organization-local Monday.
  CONSTRAINT weekly_report_recurrences_next_period_monday_check
    CHECK (EXTRACT(ISODOW FROM next_period_start) = 1),
  CONSTRAINT weekly_report_recurrences_questions_check
    CHECK (jsonb_typeof(manager_questions) = 'array'),
  CONSTRAINT weekly_report_recurrences_instructions_check
    CHECK (
      instructions IS NULL
      OR (char_length(instructions) >= 1 AND char_length(instructions) <= 2000)
    ),
  CONSTRAINT weekly_report_recurrences_disabled_reason_check
    CHECK (disabled_reason IS NULL OR disabled_reason IN ('MANUAL', 'STAFF_INELIGIBLE')),
  -- enabled XOR disabled: a paused rule always carries a reason, an enabled
  -- rule never does. This is what makes the public ACTIVE/PAUSED state a
  -- total function of two columns that cannot disagree.
  CONSTRAINT weekly_report_recurrences_state_check
    CHECK ((enabled = FALSE) = (disabled_reason IS NOT NULL)),
  CONSTRAINT weekly_report_recurrences_last_outcome_check
    CHECK (last_outcome IS NULL OR last_outcome IN ('created', 'existing')),
  -- Lease consistency: a token without an expiry (or vice versa) would make
  -- crash recovery ambiguous.
  CONSTRAINT weekly_report_recurrences_lease_check
    CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);

-- Due discovery walks enabled rules in (next_period_start, id) order and
-- skips locked rows. Partial on `enabled` because paused rules are never due.
CREATE INDEX weekly_report_recurrences_due_idx
  ON weekly_report_recurrences (next_period_start, id)
  WHERE enabled;
