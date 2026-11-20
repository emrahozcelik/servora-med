-- JOB-010 release 2b: assignment offers, acceptance deadline and Staff answers.
--
-- A management assignment of a PRODUCT_DELIVERY / SALES_MEETING is a customer
-- commitment. Release 2b makes it explicit and answerable: who was asked, by
-- which deadline, how they answered, and why the assignment was taken back.
-- While `JOB_ASSIGNMENT_WINDOW_ENABLED` is false (the default) no row is ever
-- written by the application; the schema is inert.
--
-- Tables:
--   job_card_assignment_offers
--     Durable, server-owned record of one "please take this job by then"
--     request. At most one row per job is OPEN (partial UNIQUE); closed rows
--     accumulate as append-only history and are never reopened. An optional
--     assignment-history link exists only when the producer wrote one.
--   job_card_assignment_offer_notifications
--     Once-per-offer-and-kind automatic delivery state, so a restarted or
--     concurrent expiry worker converges instead of re-notifying.
--
-- Additive only: no column is added to an existing table, no existing row is
-- modified, and every widened CHECK keeps its complete previous vocabulary.

CREATE TABLE job_card_assignment_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  job_card_id UUID NOT NULL,
  -- The Staff member the offer was addressed to. History is never rewritten
  -- by a later reassignment.
  assignee_user_id UUID NOT NULL,
  -- The request clock (or the 049 reservation instant for lifecycle commands)
  -- at which the offer became answerable.
  opened_at TIMESTAMPTZ NOT NULL,
  opened_reason VARCHAR(30) NOT NULL,
  -- Always the authenticated management actor; offboarding runs as an ADMIN.
  opened_by UUID NOT NULL,
  -- Optional link to job_card_assignment_history. Deliberately not a FK: a
  -- producer that wrote no history row stores NULL, and the offer is never
  -- required to have one.
  assignment_history_id UUID,
  acceptance_due_at TIMESTAMPTZ NOT NULL,
  urgent_reason VARCHAR(20),
  -- Past-start acknowledgement: only representable for a START_PASSED offer
  -- and always with its mandatory text.
  ack_code VARCHAR(40),
  ack_text TEXT,
  state VARCHAR(10) NOT NULL,
  closed_at TIMESTAMPTZ,
  -- NULL only for EXPIRED, which is a clock-only/system close.
  closed_by UUID,
  close_reason VARCHAR(40),
  close_text TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT job_card_assignment_offers_opened_reason_check CHECK (opened_reason IN (
    'CREATE',
    'REASSIGN',
    'RESCHEDULE',
    'FOLLOW_UP_CREATE',
    'APPROVE_FOLLOW_UP',
    'CANCEL_REPLACEMENT',
    'OFFBOARDING_TRANSFER',
    'REOFFER'
  )),
  CONSTRAINT job_card_assignment_offers_state_check CHECK (state IN (
    'OPEN',
    'ACCEPTED',
    'DECLINED',
    'RELEASED',
    'EXPIRED',
    'WITHDRAWN'
  )),
  CONSTRAINT job_card_assignment_offers_urgent_reason_check CHECK (
    urgent_reason IS NULL OR urgent_reason IN ('SHORT_NOTICE', 'START_PASSED')
  ),
  CONSTRAINT job_card_assignment_offers_ack_check CHECK (
    (ack_code IS NULL AND ack_text IS NULL)
    OR (
      ack_code IN ('CUSTOMER_CONFIRMED_LATER_TIME', 'CUSTOMER_WAITING', 'OTHER')
      AND ack_text IS NOT NULL
      AND CHAR_LENGTH(BTRIM(ack_text)) BETWEEN 1 AND 2000
    )
  ),
  -- An acknowledgement only exists on a start-passed offer.
  CONSTRAINT job_card_assignment_offers_ack_urgent_check CHECK (
    ack_code IS NULL OR urgent_reason = 'START_PASSED'
  ),
  CONSTRAINT job_card_assignment_offers_close_reason_check CHECK (
    close_reason IS NULL OR close_reason IN (
      'SCHEDULE_CONFLICT',
      'ON_LEAVE',
      'TOO_FAR',
      'MISSING_STOCK_OR_EQUIPMENT',
      'OTHER',
      'REASSIGNED',
      'RESCHEDULED',
      'CANCELLED',
      'INVALIDATED',
      'OFFBOARDING_TRANSFER',
      'PLANNED_WINDOW_PASSED'
    )
  ),
  CONSTRAINT job_card_assignment_offers_close_text_check CHECK (
    close_text IS NULL OR CHAR_LENGTH(BTRIM(close_text)) BETWEEN 1 AND 2000
  ),
  -- Paired close fact: an OPEN offer states no closing fact; a closed one
  -- states the instant, the actor (except a system expiry) and exactly the
  -- reason shape its state owns.
  CONSTRAINT job_card_assignment_offers_closure_check CHECK (
    (
      state = 'OPEN'
      AND closed_at IS NULL
      AND closed_by IS NULL
      AND close_reason IS NULL
      AND close_text IS NULL
    ) OR (
      state IN ('ACCEPTED', 'DECLINED', 'RELEASED', 'EXPIRED', 'WITHDRAWN')
      AND closed_at IS NOT NULL
      AND (state = 'EXPIRED' OR closed_by IS NOT NULL)
      AND (
        (
          state IN ('DECLINED', 'RELEASED')
          AND close_reason IN (
            'SCHEDULE_CONFLICT',
            'ON_LEAVE',
            'TOO_FAR',
            'MISSING_STOCK_OR_EQUIPMENT',
            'OTHER'
          )
          AND close_text IS NOT NULL
        ) OR (
          state = 'WITHDRAWN'
          AND close_reason IN (
            'REASSIGNED',
            'RESCHEDULED',
            'CANCELLED',
            'INVALIDATED',
            'OFFBOARDING_TRANSFER',
            'PLANNED_WINDOW_PASSED'
          )
          AND close_text IS NULL
        ) OR (
          state IN ('ACCEPTED', 'EXPIRED')
          AND close_reason IS NULL
          AND close_text IS NULL
        )
      )
    )
  ),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, assignee_user_id)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, opened_by)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, closed_by)
    REFERENCES users (organization_id, id)
);

-- At most one OPEN offer per job. Closed rows accumulate as history.
CREATE UNIQUE INDEX job_card_assignment_offers_open_key
  ON job_card_assignment_offers (organization_id, job_card_id)
  WHERE state = 'OPEN';

-- Latest-offer reads (detail, lists) and the management needs-action list.
CREATE INDEX job_card_assignment_offers_job_idx
  ON job_card_assignment_offers (organization_id, job_card_id, opened_at DESC, id DESC);

CREATE INDEX job_card_assignment_offers_state_idx
  ON job_card_assignment_offers (organization_id, state, acceptance_due_at, id);

-- Automatic reminder / expiry delivery state: one row per offer and kind.
CREATE TABLE job_card_assignment_offer_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  offer_id UUID NOT NULL
    REFERENCES job_card_assignment_offers(id) ON DELETE RESTRICT,
  kind VARCHAR(30) NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT job_card_assignment_offer_notifications_kind_check CHECK (kind IN (
    'ACCEPTANCE_REMINDER',
    'ACCEPTANCE_EXPIRED'
  )),
  -- Once per offer and kind: restarts and competing workers converge here
  -- instead of duplicating notifications.
  CONSTRAINT job_card_assignment_offer_notifications_offer_kind_key
    UNIQUE (offer_id, kind)
);

CREATE INDEX job_card_assignment_offer_notifications_offer_idx
  ON job_card_assignment_offer_notifications (offer_id, sent_at DESC);

-- The two assignment commands become representable in the 049 lifecycle
-- reservation ledger. The list is the complete original vocabulary plus the
-- two new commands; no existing value is dropped or renamed.
ALTER TABLE job_card_lifecycle_intents
  DROP CONSTRAINT job_card_lifecycle_intents_command_check,
  ADD CONSTRAINT job_card_lifecycle_intents_command_check CHECK (command IN (
    'ACCEPT_ASSIGNMENT',
    'START',
    'SUBMIT_FOR_APPROVAL',
    'APPROVE',
    'REQUEST_REVISION',
    'WITHDRAW_FROM_APPROVAL',
    'RESUME',
    'CANCEL',
    'DECLINE_ASSIGNMENT',
    'RELEASE_ASSIGNMENT'
  ));

-- The offer lifecycle becomes representable in the append-only activity
-- ledger. The list is the complete 064 vocabulary plus the new events; no
-- existing value is dropped or renamed. JOB_ASSIGNMENT_REMINDER_SENT records
-- the automatic reminder fact: an in-app notification is transported through
-- a realtime event whose source must be an activity row, and the reminder is
-- deliberately not a lifecycle transition.
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
    'JOB_CHANGE_REQUEST_RESOLVED',
    'JOB_ASSIGNMENT_OFFER_OPENED',
    'JOB_ASSIGNMENT_REMINDER_SENT',
    'JOB_ASSIGNMENT_DECLINED',
    'JOB_ASSIGNMENT_RELEASED',
    'JOB_ASSIGNMENT_OFFER_EXPIRED',
    'JOB_ASSIGNMENT_OFFER_WITHDRAWN'
  ));

-- The three notification kinds become representable. The list is the complete
-- 064 vocabulary plus the new kinds; no existing kind is renamed or removed.
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
    'job.acceptance_reminder',
    'job.assignment_declined',
    'job.acceptance_expired',
    'calendar.assigned',
    'calendar.rescheduled',
    'calendar.cancelled',
    'calendar.reminder',
    'message.received'
  ));

-- Fail closed: offer history starts empty (no historical backfill), and every
-- widened CHECK must actually accept the new vocabulary.
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM job_card_assignment_offers) <> 0 THEN
    RAISE EXCEPTION 'job_card_assignment_offers must start empty (no historical backfill)';
  END IF;
  IF (SELECT COUNT(*) FROM job_card_assignment_offer_notifications) <> 0 THEN
    RAISE EXCEPTION 'job_card_assignment_offer_notifications must start empty';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_lifecycle_intents'::regclass
       AND conname = 'job_card_lifecycle_intents_command_check'
       AND pg_get_constraintdef(oid) LIKE '%DECLINE_ASSIGNMENT%'
       AND pg_get_constraintdef(oid) LIKE '%RELEASE_ASSIGNMENT%'
  ) THEN
    RAISE EXCEPTION 'job_card_lifecycle_intents command CHECK must accept the assignment commands';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_activity_logs'::regclass
       AND conname = 'job_card_activity_logs_event_type_check'
       AND pg_get_constraintdef(oid) LIKE '%JOB_ASSIGNMENT_OFFER_OPENED%'
       AND pg_get_constraintdef(oid) LIKE '%JOB_ASSIGNMENT_OFFER_WITHDRAWN%'
       AND pg_get_constraintdef(oid) LIKE '%JOB_CHANGE_REQUEST_RESOLVED%'
  ) THEN
    RAISE EXCEPTION 'job_card_activity_logs event CHECK must accept the assignment-offer events';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'in_app_notifications'::regclass
       AND conname = 'in_app_notifications_kind_check'
       AND pg_get_constraintdef(oid) LIKE '%job.acceptance_reminder%'
       AND pg_get_constraintdef(oid) LIKE '%job.assignment_declined%'
       AND pg_get_constraintdef(oid) LIKE '%job.acceptance_expired%'
  ) THEN
    RAISE EXCEPTION 'in_app_notifications kind CHECK must accept the acceptance kinds';
  END IF;
  IF to_regclass('job_card_assignment_offers_open_key') IS NULL THEN
    RAISE EXCEPTION 'job_card_assignment_offers must keep its one-open-offer unique index';
  END IF;
END
$$;
