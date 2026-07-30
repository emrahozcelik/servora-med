-- Add job.note_added to the in-app notification kind constraint.
-- All existing kinds are preserved exactly.
ALTER TABLE in_app_notifications
  DROP CONSTRAINT in_app_notifications_kind_check;

ALTER TABLE in_app_notifications
  ADD CONSTRAINT in_app_notifications_kind_check
    CHECK (kind IN (
      'job.assigned',
      'job.reassigned',
      'job.awaiting_approval',
      'job.approved',
      'job.revision_requested',
      'job.cancelled',
      'job.note_added',
      'calendar.assigned',
      'calendar.rescheduled',
      'calendar.cancelled',
      'calendar.reminder',
      'message.received'
    ));
