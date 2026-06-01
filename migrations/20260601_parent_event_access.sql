CREATE TABLE IF NOT EXISTS school_access_memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  access_role text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requested_at timestamptz DEFAULT now(),
  approved_at timestamptz,
  updated_at timestamptz DEFAULT now(),
  approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  notes text,
  PRIMARY KEY (user_id, school_id, access_role)
);

CREATE INDEX IF NOT EXISTS school_access_memberships_school_id_idx
ON school_access_memberships (school_id, access_role, status);

ALTER TABLE school_access_memberships
  DROP CONSTRAINT IF EXISTS school_access_memberships_access_role_check;

ALTER TABLE school_access_memberships
  ADD CONSTRAINT school_access_memberships_access_role_check
  CHECK (access_role IN ('parent_guardian'));

ALTER TABLE school_access_memberships
  DROP CONSTRAINT IF EXISTS school_access_memberships_status_check;

ALTER TABLE school_access_memberships
  ADD CONSTRAINT school_access_memberships_status_check
  CHECK (status IN ('pending', 'approved', 'revoked'));
