-- Additive infrastructure only; the canonical connection table is unchanged.
CREATE TABLE exchange_action_rate_limits (
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket varchar(32) NOT NULL CHECK (bucket IN ('REQUEST_HOUR','REQUEST_DAY','TRANSITION_HOUR','REPORT_HOUR','PAIR_MINUTE')),
  target_key varchar(36) NOT NULL DEFAULT '',
  hits integer NOT NULL CHECK (hits BETWEEN 1 AND 61),
  reset_at timestamptz NOT NULL,
  PRIMARY KEY(actor_id,bucket,target_key),
  CHECK ((bucket='PAIR_MINUTE' AND target_key ~ '^[a-f0-9-]{36}$') OR (bucket<>'PAIR_MINUTE' AND target_key=''))
);
CREATE INDEX exchange_action_rate_limits_expiry_idx ON exchange_action_rate_limits(reset_at);
