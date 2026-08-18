ALTER TABLE in_app_notifications
  ADD COLUMN dismissed_at TIMESTAMPTZ;

CREATE INDEX in_app_notifications_visible_recipient_idx
  ON in_app_notifications (
    organization_id,
    recipient_user_id,
    created_at DESC,
    id DESC
  )
  WHERE dismissed_at IS NULL;
