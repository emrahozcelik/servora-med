-- 026_messaging_participant_lifecycle.sql
-- M9: explicit Job assignee conversation sync support.
--
-- Adds exactly:
--   1. nullable details JSONB on messaging_activity_logs (audit payload for
--      PARTICIPANTS_CHANGED with assignmentTransitionId + user ID lists)
--   2. PARTICIPANTS_CHANGED activity action (single atomic security mutation
--      per effective participant sync)
--   3. conversation.participants_changed realtime event type
--
-- No participant columns/tables, no idempotency constraint changes, no
-- read-state schema change, no soft-delete, no epoch model.

ALTER TABLE messaging_activity_logs
  ADD COLUMN details JSONB;

ALTER TABLE messaging_activity_logs
  DROP CONSTRAINT messaging_activity_action_check,
  ADD CONSTRAINT messaging_activity_action_check
    CHECK (action IN (
      'CONVERSATION_CREATED',
      'MESSAGE_SENT',
      'READ_CURSOR_UPDATED',
      'PARTICIPANTS_CHANGED'
    ));

ALTER TABLE realtime_events
  DROP CONSTRAINT realtime_events_event_type_check,
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
      'confidential-note.created',
      'conversation.participants_changed'
    ));
