ALTER TABLE job_cards
  DROP CONSTRAINT job_cards_type_check,
  ADD CONSTRAINT job_cards_type_check CHECK (type IN (
    'PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING'
  ));

ALTER TABLE job_card_activity_logs
  DROP CONSTRAINT job_card_activity_logs_event_type_check,
  ADD CONSTRAINT job_card_activity_logs_event_type_check CHECK (event_type IN (
    'JOB_CREATED', 'JOB_ASSIGNED', 'JOB_PLANNED', 'JOB_STARTED',
    'JOB_SUBMITTED_FOR_APPROVAL', 'JOB_APPROVED', 'JOB_REVISION_REQUESTED',
    'JOB_RESUMED', 'JOB_CANCELLED', 'JOB_FIELDS_UPDATED',
    'DELIVERY_ITEM_ADDED', 'DELIVERY_ITEM_UPDATED', 'DELIVERY_ITEM_REMOVED',
    'NOTE_ADDED', 'MEETING_DETAILS_UPDATED'
  ));

CREATE TABLE job_card_meeting_details (
  job_card_id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  meeting_at TIMESTAMPTZ,
  outcome VARCHAR(40),
  meeting_summary TEXT,
  next_follow_up_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT meeting_details_outcome_check CHECK (
    outcome IS NULL OR outcome IN (
      'POSITIVE', 'FOLLOW_UP_REQUIRED', 'NO_DECISION', 'NOT_INTERESTED'
    )
  ),
  CONSTRAINT meeting_details_summary_check CHECK (
    meeting_summary IS NULL OR (
      char_length(meeting_summary) BETWEEN 1 AND 4000
      AND meeting_summary ~ '[^[:space:]]'
    )
  ),
  CONSTRAINT meeting_details_follow_up_check CHECK (
    next_follow_up_at IS NULL OR (
      meeting_at IS NOT NULL AND next_follow_up_at > meeting_at
    )
  )
);

CREATE INDEX meeting_details_org_time_job_idx
  ON job_card_meeting_details (organization_id, meeting_at, job_card_id)
  WHERE meeting_at IS NOT NULL;
