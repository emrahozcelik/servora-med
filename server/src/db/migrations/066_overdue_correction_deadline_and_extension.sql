-- OVR-5a (readers): revision correction deadline and authorized deadline
-- extension. Accepted contract: DECISIONS.md OVR-5 and
-- docs/features/overdue-correction-deadline-and-extension.md (§3, §4, §7).
--
-- OVR-5a writes none of these columns yet; it only teaches every reader to
-- honor them. OVR-5b (migration 067) adds the producers and the UI.
--
-- Additive only: two nullable column groups, widened vocabularies, one extra
-- UNIQUE identity next to the retained 053 episode identity. No row is
-- backfilled or rewritten: the migration executes no DML on existing rows.
--
-- Terminology:
--   correction_due_at = the management-set correction deadline of a
--     REQUEST_REVISION-armed submission episode. The episode's effective
--     submission deadline becomes max(original, correction_due_at); a job
--     without any original deadline never gets one.
--   ended_at / ended_by_user_id / end_reason / end_note /
--     ended_by_schedule_revision_no = the separate, reasoned *ending* of an
--     open obligation by an authorized deadline extension. Evidence columns
--     (deadline_at, breached_at, accountability, schedule_revision_no,
--     source) never change. Ending and recovery are mutually exclusive and
--     one-way.

ALTER TABLE job_card_submission_episode_activations
  ADD COLUMN correction_due_at TIMESTAMPTZ NULL,
  -- Only a revision activation can carry a correction deadline, and it must
  -- grant time after the arming instant. WITHDRAW_FROM_APPROVAL keeps the
  -- original deadline.
  ADD CONSTRAINT job_card_submission_episode_activations_correction_due_check
    CHECK (
      correction_due_at IS NULL
      OR (
        activated_by_command = 'REQUEST_REVISION'
        AND correction_due_at > activated_at
      )
    );

ALTER TABLE job_card_overdue_incidents
  ADD COLUMN ended_at TIMESTAMPTZ,
  ADD COLUMN ended_by_user_id UUID,
  ADD COLUMN end_reason VARCHAR(30),
  ADD COLUMN end_note TEXT,
  ADD COLUMN ended_by_schedule_revision_no INTEGER,
  -- Ending is a complete, reasoned fact: all five columns are set together or
  -- none is. Never half-populated.
  ADD CONSTRAINT job_card_overdue_incidents_ending_set_check
    CHECK (
      (
        ended_at IS NULL
        AND ended_by_user_id IS NULL
        AND end_reason IS NULL
        AND end_note IS NULL
        AND ended_by_schedule_revision_no IS NULL
      ) OR (
        ended_at IS NOT NULL
        AND ended_by_user_id IS NOT NULL
        AND end_reason IS NOT NULL
        AND end_note IS NOT NULL
        AND ended_by_schedule_revision_no IS NOT NULL
      )
    ),
  -- Recovery and ending cannot both close the same obligation.
  ADD CONSTRAINT job_card_overdue_incidents_ending_exclusive_check
    CHECK (NOT (recovered_at IS NOT NULL AND ended_at IS NOT NULL)),
  -- An obligation is never ended before it was breached.
  ADD CONSTRAINT job_card_overdue_incidents_ending_instant_check
    CHECK (ended_at IS NULL OR ended_at >= breached_at),
  ADD CONSTRAINT job_card_overdue_incidents_end_reason_check
    CHECK (end_reason IS NULL OR end_reason IN ('DEADLINE_EXTENDED')),
  ADD CONSTRAINT job_card_overdue_incidents_end_note_check
    CHECK (end_note IS NULL OR CHAR_LENGTH(BTRIM(end_note)) BETWEEN 1 AND 500),
  -- The ending actor and the appended schedule revision belong to the same
  -- org/job. A revision that proves the new boundary is never deleted while an
  -- incident references it.
  ADD CONSTRAINT job_card_overdue_incidents_ended_by_user_fk
    FOREIGN KEY (organization_id, ended_by_user_id)
    REFERENCES users (organization_id, id),
  ADD CONSTRAINT job_card_overdue_incidents_ended_by_revision_fk
    FOREIGN KEY (organization_id, job_card_id, ended_by_schedule_revision_no)
    REFERENCES job_card_schedule_revisions (organization_id, job_card_id, revision_no)
    ON DELETE RESTRICT;

-- The ending becomes representable in the append-only activity ledger. The
-- list is the complete 065 vocabulary plus the new event; no existing value is
-- dropped or renamed. The reason and incident facts stay in the
-- management-only incident history; the timeline renders the event as a plain
-- fact.
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
    'JOB_ASSIGNMENT_OFFER_WITHDRAWN',
    'JOB_OVERDUE_ENDED_BY_EXTENSION'
  ));

-- OVR-4 delivery identity moves to the canonical incident of an episode. The
-- 053 per-episode key stays in place so the previous release (b0d3341) keeps
-- working while OVR-5a is live; migration 067 drops it in OVR-5b. Existing
-- rows already satisfy the new key: an incident belongs to exactly one
-- episode, and the 053 key allows one row per episode and kind.
ALTER TABLE job_card_overdue_notification_deliveries
  ADD CONSTRAINT job_card_overdue_notification_deliveries_incident_kind_key
  UNIQUE (organization_id, incident_id, kind);

-- Fail closed: no row may already carry the new facts (no backfill), and every
-- constraint must actually exist with its accepted definition. The tables are
-- not required to be empty, only the new columns.
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM job_card_overdue_incidents
       WHERE ended_at IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'job_card_overdue_incidents must not be pre-populated with endings';
  END IF;
  IF (SELECT COUNT(*) FROM job_card_submission_episode_activations
       WHERE correction_due_at IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'job_card_submission_episode_activations must not be pre-populated with correction deadlines';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_submission_episode_activations'::regclass
       AND conname = 'job_card_submission_episode_activations_correction_due_check'
       AND pg_get_constraintdef(oid) LIKE '%correction_due_at%'
       AND pg_get_constraintdef(oid) LIKE '%REQUEST_REVISION%'
  ) THEN
    RAISE EXCEPTION 'correction deadline CHECK must bind REQUEST_REVISION activations';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_overdue_incidents'::regclass
       AND conname = 'job_card_overdue_incidents_ending_set_check'
       AND pg_get_constraintdef(oid) LIKE '%ended_by_schedule_revision_no%'
  ) THEN
    RAISE EXCEPTION 'job_card_overdue_incidents must keep the all-or-none ending shape';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_overdue_incidents'::regclass
       AND conname = 'job_card_overdue_incidents_ending_exclusive_check'
       AND pg_get_constraintdef(oid) LIKE '%recovered_at%'
       AND pg_get_constraintdef(oid) LIKE '%ended_at%'
  ) THEN
    RAISE EXCEPTION 'job_card_overdue_incidents must keep recovery and ending exclusive';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_overdue_incidents'::regclass
       AND conname = 'job_card_overdue_incidents_ending_instant_check'
       AND pg_get_constraintdef(oid) LIKE '%breached_at%'
  ) THEN
    RAISE EXCEPTION 'job_card_overdue_incidents must keep ended_at >= breached_at';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_overdue_incidents'::regclass
       AND conname = 'job_card_overdue_incidents_end_reason_check'
       AND pg_get_constraintdef(oid) LIKE '%DEADLINE_EXTENDED%'
  ) THEN
    RAISE EXCEPTION 'job_card_overdue_incidents must keep the DEADLINE_EXTENDED reason';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_overdue_incidents'::regclass
       AND conname = 'job_card_overdue_incidents_end_note_check'
       AND pg_get_constraintdef(oid) LIKE '%500%'
  ) THEN
    RAISE EXCEPTION 'job_card_overdue_incidents must keep the bounded end note';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_overdue_incidents'::regclass
       AND conname = 'job_card_overdue_incidents_ended_by_user_fk'
       AND contype = 'f'
       AND pg_get_constraintdef(oid) LIKE '%REFERENCES users(organization_id, id)%'
  ) THEN
    RAISE EXCEPTION 'job_card_overdue_incidents ending actor must reference users in the org';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_overdue_incidents'::regclass
       AND conname = 'job_card_overdue_incidents_ended_by_revision_fk'
       AND contype = 'f'
       AND pg_get_constraintdef(oid) LIKE '%job_card_schedule_revisions(organization_id, job_card_id, revision_no)%'
       AND pg_get_constraintdef(oid) LIKE '%ON DELETE RESTRICT%'
  ) THEN
    RAISE EXCEPTION 'job_card_overdue_incidents must bind the ending to the appended revision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_activity_logs'::regclass
       AND conname = 'job_card_activity_logs_event_type_check'
       AND pg_get_constraintdef(oid) LIKE '%JOB_OVERDUE_ENDED_BY_EXTENSION%'
       AND pg_get_constraintdef(oid) LIKE '%JOB_ASSIGNMENT_OFFER_WITHDRAWN%'
  ) THEN
    RAISE EXCEPTION 'job_card_activity_logs event CHECK must accept JOB_OVERDUE_ENDED_BY_EXTENSION';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_overdue_notification_deliveries'::regclass
       AND conname = 'job_card_overdue_notification_deliveries_incident_kind_key'
       AND pg_get_constraintdef(oid) LIKE '%(organization_id, incident_id, kind)%'
  ) THEN
    RAISE EXCEPTION 'job_card_overdue_notification_deliveries must keep the incident delivery key';
  END IF;
END
$$;
