-- 029_messaging_conversation_archive.sql
-- Per-user conversation organization state. This is deliberately separate
-- from conversation_participants because participant rows can be removed and
-- recreated during JOB assignment lifecycle changes.

CREATE TABLE conversation_user_states (
  organization_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  user_id UUID NOT NULL,
  archived_at TIMESTAMPTZ,

  CONSTRAINT conversation_user_states_pk
    PRIMARY KEY (organization_id, conversation_id, user_id),
  CONSTRAINT conversation_user_states_conversation_fk
    FOREIGN KEY (organization_id, conversation_id)
    REFERENCES conversations (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_user_states_user_fk
    FOREIGN KEY (organization_id, user_id)
    REFERENCES users (organization_id, id) ON DELETE CASCADE
);

CREATE INDEX conversation_user_states_user_archive_idx
  ON conversation_user_states (organization_id, user_id, archived_at, conversation_id);
