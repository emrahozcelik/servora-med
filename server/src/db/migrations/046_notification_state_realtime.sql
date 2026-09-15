-- 046: allow source-less notification state invalidations.
--
-- Notification read/dismiss/clear state changes do not own a domain activity
-- row, so they cannot satisfy the exact-one-source invariant that protects the
-- realtime audit ledger. This migration creates a NARROW exception that is valid
-- ONLY for event_type = 'notification.state_changed':
--
--   * the new type must carry NO activity source (all source columns NULL);
--   * every other event type keeps the existing exact-one-source invariant;
--   * no foreign key or unique constraint on existing source columns changes.
--
-- The event describes the viewer's Notification Center canonical state
-- (entity_type = 'notification-center', entity_id = viewer user id) and carries
-- resource_keys = ['notifications']. It never projects into a new notification.

ALTER TABLE realtime_events
  DROP CONSTRAINT realtime_events_event_type_check,
  ADD CONSTRAINT realtime_events_event_type_check CHECK (event_type IN (
    'job.created',
    'job.assignment_changed',
    'job.accepted',
    'job.started',
    'job.submitted_for_approval',
    'job.approved',
    'job.revision_requested',
    'job.cancelled',
    'job.invalidated',
    'job.updated',
    'calendar.created',
    'calendar.updated',
    'calendar.cancelled',
    'calendar.reminder_due',
    'message.sent',
    'conversation.created',
    'confidential-note.created',
    'conversation.participants_changed',
    'notification.state_changed'
  ));

ALTER TABLE realtime_events
  DROP CONSTRAINT realtime_events_entity_type_check,
  ADD CONSTRAINT realtime_events_entity_type_check CHECK (entity_type IN (
    'job-card',
    'calendar-event',
    'conversation',
    'confidential-note',
    'notification-center'
  ));

ALTER TABLE realtime_events
  DROP CONSTRAINT realtime_events_activity_source_check,
  ADD CONSTRAINT realtime_events_activity_source_check CHECK (
    (
      (source_activity_id IS NOT NULL)::INTEGER
      + (calendar_activity_id IS NOT NULL)::INTEGER
      + (calendar_reminder_id IS NOT NULL)::INTEGER
      + (messaging_activity_id IS NOT NULL)::INTEGER
      + (staff_note_id IS NOT NULL)::INTEGER = 1
    )
    OR (
      event_type = 'notification.state_changed'
      AND source_activity_id IS NULL
      AND calendar_activity_id IS NULL
      AND calendar_reminder_id IS NULL
      AND messaging_activity_id IS NULL
      AND staff_note_id IS NULL
    )
  );
