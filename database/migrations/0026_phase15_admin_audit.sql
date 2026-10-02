BEGIN;

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action varchar(80) NOT NULL,
  target_type varchar(80) NOT NULL,
  target_id varchar(200) NOT NULL,
  reason varchar(1000) NOT NULL,
  correlation_id varchar(120) NOT NULL,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_audit_log_action_check CHECK (length(btrim(action)) BETWEEN 1 AND 80),
  CONSTRAINT admin_audit_log_target_type_check CHECK (length(btrim(target_type)) BETWEEN 1 AND 80),
  CONSTRAINT admin_audit_log_target_id_check CHECK (length(btrim(target_id)) BETWEEN 1 AND 200),
  CONSTRAINT admin_audit_log_reason_check CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  CONSTRAINT admin_audit_log_correlation_check CHECK (length(btrim(correlation_id)) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS admin_audit_log_target_idx
  ON admin_audit_log (target_type, target_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS admin_audit_log_actor_idx
  ON admin_audit_log (actor_user_id, created_at DESC, id DESC);

COMMIT;
