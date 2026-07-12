ALTER TABLE organizations
  ADD COLUMN timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/Istanbul';

ALTER TABLE users
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE INDEX users_organization_role_idx ON users (organization_id, role);
CREATE INDEX users_organization_active_idx ON users (organization_id)
  WHERE is_active = TRUE;

CREATE TABLE staff_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL UNIQUE,
  title VARCHAR(255),
  phone VARCHAR(50),
  region VARCHAR(100),
  manager_user_id UUID,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, manager_user_id)
    REFERENCES users (organization_id, id)
);

CREATE INDEX staff_profiles_organization_idx ON staff_profiles (organization_id);
CREATE INDEX staff_profiles_manager_idx ON staff_profiles (organization_id, manager_user_id);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  actor_user_id UUID NOT NULL,
  subject_type VARCHAR(40) NOT NULL
    CHECK (subject_type IN ('USER', 'STAFF_PROFILE')),
  subject_id UUID NOT NULL,
  event_type VARCHAR(80) NOT NULL
    CHECK (event_type IN (
      'USER_CREATED', 'USER_ROLE_CHANGED', 'USER_ACTIVATED',
      'USER_DEACTIVATED', 'USER_PASSWORD_RESET',
      'STAFF_PROFILE_UPDATED', 'STAFF_MANAGER_CHANGED'
    )),
  old_value JSONB,
  new_value JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES users (organization_id, id)
);

CREATE INDEX audit_events_subject_idx
  ON audit_events (organization_id, subject_type, subject_id, created_at DESC);
CREATE INDEX audit_events_organization_created_idx
  ON audit_events (organization_id, created_at DESC);
