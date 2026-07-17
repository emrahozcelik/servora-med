-- Historical PLAN may have been executed by management; PLANNED does not prove Staff acceptance.
UPDATE job_cards SET status = 'NEW' WHERE status = 'PLANNED';

ALTER TABLE job_cards
  DROP CONSTRAINT job_cards_status_check,
  ADD CONSTRAINT job_cards_status_check CHECK (status IN (
    'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL',
    'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED'
  ));

ALTER TABLE job_cards
  DROP CONSTRAINT job_cards_planned_status_timestamp_check;

ALTER TABLE job_cards
  ADD COLUMN accepted_at TIMESTAMPTZ NULL,
  ADD COLUMN accepted_by UUID NULL,
  ADD COLUMN scheduled_at TIMESTAMPTZ NULL;

ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_organization_accepted_by_fk
  FOREIGN KEY (organization_id, accepted_by)
  REFERENCES users (organization_id, id);

ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_accepted_status_timestamp_check
  CHECK (status <> 'ACCEPTED' OR (accepted_at IS NOT NULL AND accepted_by IS NOT NULL));

ALTER TABLE job_card_activity_logs
  DROP CONSTRAINT job_card_activity_logs_event_type_check,
  ADD CONSTRAINT job_card_activity_logs_event_type_check CHECK (event_type IN (
    'JOB_CREATED', 'JOB_ASSIGNED', 'JOB_PLANNED', 'JOB_ACCEPTED', 'JOB_STARTED',
    'JOB_SUBMITTED_FOR_APPROVAL', 'JOB_APPROVED', 'JOB_REVISION_REQUESTED',
    'JOB_RESUMED', 'JOB_CANCELLED', 'JOB_FIELDS_UPDATED',
    'DELIVERY_ITEM_ADDED', 'DELIVERY_ITEM_UPDATED', 'DELIVERY_ITEM_REMOVED',
    'NOTE_ADDED', 'MEETING_DETAILS_UPDATED', 'JOB_APPROVAL_WITHDRAWN'
  ));

-- Actual delivery time is recorded during execution; planned work uses job_cards.scheduled_at.
-- Do not backfill delivered_at from scheduled_at.
ALTER TABLE job_card_delivery_items
  ALTER COLUMN delivered_at DROP NOT NULL;
