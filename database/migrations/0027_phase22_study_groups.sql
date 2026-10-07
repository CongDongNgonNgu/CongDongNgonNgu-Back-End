-- Separate group content; existing author-private community records remain unchanged.
CREATE TABLE study_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 120),
  description varchar(500) NOT NULL DEFAULT '',
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  owner_status text NOT NULL DEFAULT 'ACTIVE' CHECK (owner_status = 'ACTIVE'),
  owner_role text NOT NULL DEFAULT 'OWNER' CHECK (owner_role = 'OWNER'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE study_group_memberships (
  group_id uuid NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('OWNER','MODERATOR','MEMBER')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LEFT','REMOVED')),
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (group_id,user_id),
  UNIQUE (group_id,user_id,status,role),
  CHECK (status = 'ACTIVE' OR role = 'MEMBER')
);
CREATE UNIQUE INDEX study_group_single_owner_idx ON study_group_memberships(group_id) WHERE status = 'ACTIVE' AND role = 'OWNER';
ALTER TABLE study_groups ADD CONSTRAINT study_group_current_owner_fk
  FOREIGN KEY (id,owner_user_id,owner_status,owner_role)
  REFERENCES study_group_memberships(group_id,user_id,status,role)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX study_group_memberships_user_idx ON study_group_memberships(user_id,status,group_id);
CREATE INDEX study_groups_owner_idx ON study_groups(owner_user_id);
CREATE TABLE study_group_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  issuer_user_id uuid NOT NULL,
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by_user_id uuid,
  revoked_at timestamptz,
  FOREIGN KEY (group_id,issuer_user_id) REFERENCES study_group_memberships(group_id,user_id),
  FOREIGN KEY (group_id,accepted_by_user_id) REFERENCES study_group_memberships(group_id,user_id),
  CHECK (expires_at > created_at),
  CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL)),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  CHECK (accepted_at IS NULL OR (accepted_at >= created_at AND accepted_at < expires_at)),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX study_group_invitation_state_idx ON study_group_invitations(group_id,expires_at,created_at,id);
CREATE TABLE study_group_texts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL,
  body varchar(2000) NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000 AND char_length(btrim(body)) > 0),
  hidden_at timestamptz,
  hidden_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (group_id,id),
  FOREIGN KEY (group_id,author_user_id) REFERENCES study_group_memberships(group_id,user_id),
  FOREIGN KEY (group_id,hidden_by_user_id) REFERENCES study_group_memberships(group_id,user_id),
  CHECK ((hidden_at IS NULL) = (hidden_by_user_id IS NULL))
);
CREATE INDEX study_group_text_order_idx ON study_group_texts(group_id,created_at,id);
CREATE TABLE study_group_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  text_id uuid NOT NULL,
  reporter_user_id uuid NOT NULL,
  reason varchar(500) NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500 AND char_length(btrim(reason)) > 0),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  resolved_by_user_id uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (group_id,text_id,reporter_user_id),
  FOREIGN KEY (group_id,text_id) REFERENCES study_group_texts(group_id,id),
  FOREIGN KEY (group_id,reporter_user_id) REFERENCES study_group_memberships(group_id,user_id),
  FOREIGN KEY (group_id,resolved_by_user_id) REFERENCES study_group_memberships(group_id,user_id),
  CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL)),
  CHECK ((resolved_at IS NULL) = (resolved_by_user_id IS NULL))
);
CREATE INDEX study_group_report_order_idx ON study_group_reports(group_id,created_at,id);
CREATE TABLE study_group_rate_limits (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('CREATE','ACCEPT','INVITE','TEXT','REPORT','MEMBERSHIP','MODERATION')),
  hits integer NOT NULL CHECK (hits BETWEEN 1 AND 20),
  reset_at timestamptz NOT NULL,
  PRIMARY KEY (user_id,action)
);
