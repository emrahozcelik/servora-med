-- JOB-010 release 2a (decision D1): Staff change/termination request.
--
-- Staff never cancel a customer's JobCard (release 2c). From release 2a they
-- send a reasoned request instead: a structured reason plus mandatory text.
-- The request NEVER changes the JobCard row, status or version, and deletes
-- nothing. Management answers it through the existing commands (correct,
-- reschedule, linked new job, cancel) or rejects it with a note; the request
-- row keeps the decision, the actor and the instants as append-only history.
--
-- At most one OPEN request per job (partial unique). Closing is one-way: an
-- OPEN row carries no resolution fact and a CLOSED row carries both the
-- resolution and its instant. CANCELLED is written by the CANCEL finalize
-- transaction, SUPERSEDED by APPROVE / ADMIN invalidation, the rest by the
-- management resolve command.
--
-- Additive only: one new table, two activity event types, two notification
-- kinds. No existing column, row or constraint value is removed.

CREATE TABLE job_card_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  job_card_id UUID NOT NULL,
  -- The assigned STAFF member at request time; history is never rewritten by
  -- a later reassignment.
  requested_by UUID NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  -- The job status the request was raised from. A request is only creatable
  -- while the job is active, so terminal statuses are not representable.
  job_status_at_request VARCHAR(30) NOT NULL,
  reason_code VARCHAR(30) NOT NULL,
  reason_text TEXT NOT NULL,
  client_action_id TEXT NOT NULL,
  state VARCHAR(10) NOT NULL,
  -- Null while OPEN. CANCELLED and SUPERSEDED are written by other commands;
  -- CORRECTED / RESCHEDULED / LINKED_JOB_CREATED / REJECTED by the resolve
  -- command.
  resolution VARCHAR(30),
  -- Null only for a system/Staff supersede path; a management decision always
  -- records its actor.
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  linked_job_card_id UUID,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT job_card_change_requests_status_check CHECK (job_status_at_request IN (
    'NEW',
    'ACCEPTED',
    'IN_PROGRESS',
    'WAITING_APPROVAL',
    'REVISION_REQUESTED'
  )),
  CONSTRAINT job_card_change_requests_reason_code_check CHECK (reason_code IN (
    'CUSTOMER_CHANGED_MIND',
    'CUSTOMER_POSTPONED',
    'CUSTOMER_ABSENT',
    'WRONG_PRODUCT',
    'MISSING_STOCK_OR_EQUIPMENT',
    'VISIT_NOT_POSSIBLE',
    'OTHER'
  )),
  CONSTRAINT job_card_change_requests_reason_text_check CHECK (
    CHAR_LENGTH(BTRIM(reason_text)) BETWEEN 1 AND 2000
  ),
  CONSTRAINT job_card_change_requests_state_check CHECK (state IN ('OPEN', 'CLOSED')),
  CONSTRAINT job_card_change_requests_resolution_check CHECK (
    resolution IS NULL OR resolution IN (
      'CANCELLED',
      'CORRECTED',
      'RESCHEDULED',
      'LINKED_JOB_CREATED',
      'REJECTED',
      'SUPERSEDED'
    )
  ),
  CONSTRAINT job_card_change_requests_resolution_note_check CHECK (
    resolution_note IS NULL OR CHAR_LENGTH(BTRIM(resolution_note)) BETWEEN 1 AND 2000
  ),
  -- Paired lifecycle fact: an OPEN request states no decision, a CLOSED one
  -- states its resolution and instant. REJECTED is the only resolution that
  -- demands a written note, and a linked job only exists on its resolution.
  CONSTRAINT job_card_change_requests_closure_check CHECK (
    (
      state = 'OPEN'
      AND resolution IS NULL
      AND resolved_at IS NULL
      AND resolved_by IS NULL
      AND resolution_note IS NULL
      AND linked_job_card_id IS NULL
    ) OR (
      state = 'CLOSED'
      AND resolution IS NOT NULL
      AND resolved_at IS NOT NULL
      AND (resolution <> 'REJECTED' OR resolution_note IS NOT NULL)
      AND (linked_job_card_id IS NULL OR (
        resolution = 'LINKED_JOB_CREATED' AND linked_job_card_id <> job_card_id
      ))
    )
  ),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, requested_by)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, resolved_by)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, linked_job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT
);

-- One OPEN request per job. Closed rows accumulate as history.
CREATE UNIQUE INDEX job_card_change_requests_open_key
  ON job_card_change_requests (organization_id, job_card_id)
  WHERE state = 'OPEN';

-- Management decision list: oldest first, scoped to one organization.
CREATE INDEX job_card_change_requests_state_idx
  ON job_card_change_requests (organization_id, state, requested_at, id);

-- The request lifecycle becomes representable in the append-only activity
-- ledger. The list is the complete 063 vocabulary plus the two new events; no
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
    'JOB_EARLY_START_AUTHORIZED',
    'JOB_CHANGE_REQUESTED',
    'JOB_CHANGE_REQUEST_RESOLVED'
  ));

-- The two notification kinds become representable. The list is the complete
-- 053 vocabulary plus the new kinds; no existing kind is renamed or removed.
ALTER TABLE in_app_notifications
  DROP CONSTRAINT in_app_notifications_kind_check,
  ADD CONSTRAINT in_app_notifications_kind_check CHECK (kind IN (
    'job.assigned',
    'job.reassigned',
    'job.awaiting_approval',
    'job.approved',
    'job.revision_requested',
    'job.cancelled',
    'job.invalidated',
    'job.note_added',
    'job.submission_reminder',
    'job.submission_auto_reminder',
    'job.submission_auto_escalation',
    'job.change_requested',
    'job.change_request_resolved',
    'calendar.assigned',
    'calendar.rescheduled',
    'calendar.cancelled',
    'calendar.reminder',
    'message.received'
  ));

-- Fail closed: request history starts empty (no historical backfill), and
-- every widened CHECK must actually accept the new vocabulary.
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM job_card_change_requests) <> 0 THEN
    RAISE EXCEPTION 'job_card_change_requests must start empty (no historical backfill)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_activity_logs'::regclass
       AND conname = 'job_card_activity_logs_event_type_check'
       AND pg_get_constraintdef(oid) LIKE '%JOB_CHANGE_REQUESTED%'
       AND pg_get_constraintdef(oid) LIKE '%JOB_CHANGE_REQUEST_RESOLVED%'
  ) THEN
    RAISE EXCEPTION 'job_card_activity_logs event CHECK must accept the change-request events';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'in_app_notifications'::regclass
       AND conname = 'in_app_notifications_kind_check'
       AND pg_get_constraintdef(oid) LIKE '%job.change_requested%'
       AND pg_get_constraintdef(oid) LIKE '%job.change_request_resolved%'
  ) THEN
    RAISE EXCEPTION 'in_app_notifications kind CHECK must accept the change-request kinds';
  END IF;
  IF to_regclass('job_card_change_requests_open_key') IS NULL THEN
    RAISE EXCEPTION 'job_card_change_requests must keep its one-open-request unique index';
  END IF;
END
$$;
