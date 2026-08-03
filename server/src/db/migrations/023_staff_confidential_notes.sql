-- Staff Confidential Notes: management-only, append-only operational notes about
-- Staff members in the same organization.
--
-- Privacy boundary: the note body lives ONLY in staff_confidential_notes. It is
-- never copied into audit_events, realtime_events, notifications, or any other
-- projection. Audit rows carry identifiers only (event type, subject ids) and
-- the realtime event carries a bodyless generic invalidation.

CREATE TABLE staff_confidential_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  staff_user_id UUID NOT NULL,
  author_user_id UUID NOT NULL,
  body VARCHAR(4000) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT staff_confidential_notes_staff_fk
    FOREIGN KEY (organization_id, staff_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT staff_confidential_notes_author_fk
    FOREIGN KEY (organization_id, author_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT staff_confidential_notes_body_check
    CHECK (
      length(trim(body)) BETWEEN 1 AND 4000
      AND body ~ '[^[:space:]]'
    )
);

CREATE INDEX staff_confidential_notes_staff_cursor_idx
  ON staff_confidential_notes (organization_id, staff_user_id, created_at DESC, id DESC);

-- Realtime: a bodyless invalidation event whose source is the note row itself.
-- Only one source may be set per realtime event; extend the existing chain.
ALTER TABLE realtime_events
  ADD COLUMN staff_note_id UUID,
  DROP CONSTRAINT realtime_events_activity_source_check,
  DROP CONSTRAINT realtime_events_event_type_check,
  DROP CONSTRAINT realtime_events_entity_type_check;

ALTER TABLE realtime_events
  ADD CONSTRAINT realtime_events_staff_note_fk
    FOREIGN KEY (staff_note_id)
    REFERENCES staff_confidential_notes(id) ON DELETE CASCADE,
  ADD CONSTRAINT realtime_events_staff_note_unique
    UNIQUE (staff_note_id),
  ADD CONSTRAINT realtime_events_activity_source_check
    CHECK (
      (source_activity_id IS NOT NULL)::INTEGER
      + (calendar_activity_id IS NOT NULL)::INTEGER
      + (calendar_reminder_id IS NOT NULL)::INTEGER
      + (messaging_activity_id IS NOT NULL)::INTEGER
      + (staff_note_id IS NOT NULL)::INTEGER = 1
    ),
  ADD CONSTRAINT realtime_events_event_type_check
    CHECK (event_type IN (
      'job.created',
      'job.assignment_changed',
      'job.accepted',
      'job.started',
      'job.submitted_for_approval',
      'job.approved',
      'job.revision_requested',
      'job.cancelled',
      'job.updated',
      'calendar.created',
      'calendar.updated',
      'calendar.cancelled',
      'calendar.reminder_due',
      'message.sent',
      'conversation.created',
      'confidential-note.created'
    )),
  ADD CONSTRAINT realtime_events_entity_type_check
    CHECK (entity_type IN (
      'job-card',
      'calendar-event',
      'conversation',
      'confidential-note'
    ));

-- Audit: identifiers only, never the note body.
ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_subject_type_check,
  DROP CONSTRAINT audit_events_event_type_check;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_subject_type_check
    CHECK (subject_type IN (
      'USER', 'STAFF_PROFILE', 'CUSTOMER', 'CONTACT', 'PRODUCT',
      'STAFF_CONFIDENTIAL_NOTE'
    )),
  ADD CONSTRAINT audit_events_event_type_check
    CHECK (event_type IN (
      'USER_CREATED', 'USER_ROLE_CHANGED', 'USER_ACTIVATED',
      'USER_DEACTIVATED', 'USER_PASSWORD_RESET',
      'STAFF_PROFILE_UPDATED', 'STAFF_MANAGER_CHANGED',
      'CUSTOMER_CREATED', 'CUSTOMER_FIELDS_UPDATED',
      'CUSTOMER_ASSIGNEE_CHANGED', 'CUSTOMER_ACTIVATED',
      'CUSTOMER_DEACTIVATED', 'CONTACT_CREATED',
      'CONTACT_FIELDS_UPDATED', 'CONTACT_MADE_PRIMARY',
      'CONTACT_ACTIVATED', 'CONTACT_DEACTIVATED',
      'PRODUCT_CREATED', 'PRODUCT_FIELDS_UPDATED',
      'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED',
      'CUSTOMER_DELETED', 'PRODUCT_DELETED',
      'STAFF_CONFIDENTIAL_NOTE_CREATED'
    ));
