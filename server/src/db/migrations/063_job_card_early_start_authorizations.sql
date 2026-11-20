-- JOB-010 release 1: durable early-start authorization.
--
-- A PRODUCT_DELIVERY or SALES_MEETING may normally START from
-- `scheduled_at - 30 minutes`. Anything earlier needs either a reschedule or
-- this management authorization. The row is the durable evidence of "which
-- management actor allowed an early start, when, under which schedule
-- revision, for which assignee and planned interval".
--
-- Validity is derived, never stored: a row is valid while it is not voided and
-- the job still has the same assignee and the same planned
-- `scheduled_at` / `scheduled_ends_at`. A reassignment or a planned-interval
-- change voids it one-way; a voided row never revives and stays readable.
--
-- Additive only: one new table, one new activity event type. No existing
-- column, row or constraint value is removed.

CREATE TABLE job_card_early_start_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID NOT NULL,
  assignee_user_id UUID NOT NULL,
  -- Schedule revision the authorization was granted under. Stored as the
  -- number only: legacy/demo fixtures may lack a revision row, and the
  -- authorization never rewrites schedule history.
  schedule_revision_no INTEGER NOT NULL CHECK (schedule_revision_no >= 1),
  scheduled_at TIMESTAMPTZ NOT NULL,
  scheduled_ends_at TIMESTAMPTZ,
  granted_by UUID NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL,
  client_action_id TEXT NOT NULL,
  voided_at TIMESTAMPTZ,
  void_reason VARCHAR(30),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT job_card_early_start_authorizations_interval_check CHECK (
    scheduled_ends_at IS NULL OR scheduled_ends_at > scheduled_at
  ),
  -- Voiding is a one-way, paired fact: an instant always carries the reason
  -- from the small management vocabulary, and a live row carries neither.
  CONSTRAINT job_card_early_start_authorizations_void_check CHECK (
    (voided_at IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND void_reason IN (
      'REASSIGNED',
      'RESCHEDULED',
      'OFFBOARDING_TRANSFER'
    ))
  ),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, assignee_user_id)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, granted_by)
    REFERENCES users (organization_id, id)
);

-- At most one live authorization per job. Voided rows accumulate as history.
CREATE UNIQUE INDEX job_card_early_start_authorizations_live_key
  ON job_card_early_start_authorizations (organization_id, job_card_id)
  WHERE voided_at IS NULL;

CREATE INDEX job_card_early_start_authorizations_job_idx
  ON job_card_early_start_authorizations (organization_id, job_card_id, granted_at DESC, id DESC);

-- The early-start grant becomes representable in the append-only activity
-- ledger. The list is the complete 061 vocabulary plus the new event; no
-- existing value is dropped or renamed.
ALTER TABLE job_card_activity_logs
  DROP CONSTRAINT job_card_activity_logs_event_type_check,
  ADD CONSTRAINT job_card_activity_logs_event_type_check CHECK (event_type IN (
    'WEEKLY_REPORT_REMOVED',
    'JOB_CREATED',
    'JOB_ASSIGNED',
    'JOB_PLANNED',
    'JOB_ACCEPTED',
    'JOB_STARTED',
    'JOB_SUBMITTED_FOR_APPROVAL',
    'JOB_APPROVED',
    'JOB_REVISION_REQUESTED',
    'JOB_RESUMED',
    'JOB_CANCELLED',
    'JOB_INVALIDATED',
    'JOB_FIELDS_UPDATED',
    'DELIVERY_ITEM_ADDED',
    'DELIVERY_ITEM_UPDATED',
    'DELIVERY_ITEM_REMOVED',
    'NOTE_ADDED',
    'MEETING_DETAILS_UPDATED',
    'JOB_APPROVAL_WITHDRAWN',
    'JOB_SUBMISSION_REMINDER_SENT',
    'JOB_SUBMISSION_AUTO_REMINDER_SENT',
    'JOB_SUBMISSION_AUTO_ESCALATION_SENT',
    'SALE_FROM_VISIT_CREATED',
    'SALE_DETAILS_UPDATED',
    'SALE_ITEM_ADDED',
    'SALE_ITEM_UPDATED',
    'SALE_ITEM_REMOVED',
    'JOB_EARLY_START_AUTHORIZED'
  ));

-- Fail closed: authorization history starts empty (no historical backfill),
-- and the activity CHECK must actually accept the new event.
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM job_card_early_start_authorizations) <> 0 THEN
    RAISE EXCEPTION 'job_card_early_start_authorizations must start empty (no historical backfill)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_activity_logs'::regclass
       AND conname = 'job_card_activity_logs_event_type_check'
       AND pg_get_constraintdef(oid) LIKE '%JOB_EARLY_START_AUTHORIZED%'
  ) THEN
    RAISE EXCEPTION 'job_card_activity_logs event CHECK must accept JOB_EARLY_START_AUTHORIZED';
  END IF;
END
$$;
