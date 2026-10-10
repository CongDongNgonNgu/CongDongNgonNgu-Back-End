CREATE TABLE direct_message_rate_limits (
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket varchar(32) NOT NULL CHECK (bucket IN ('SEND_MINUTE','SEND_HOUR')),
  hits integer NOT NULL CHECK (hits BETWEEN 1 AND 1001),
  reset_at timestamptz NOT NULL,
  PRIMARY KEY (actor_id, bucket)
);
CREATE INDEX direct_message_rate_limits_expiry_idx ON direct_message_rate_limits(reset_at);

-- Minimal atomic contract support only. Materialization/projection belongs to005.
-- Generation lets a future worker acknowledge only the generation it leased;
-- an older completion must not clear a later committed send's intent.
CREATE TABLE direct_message_notification_intents (
  conversation_id uuid NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (conversation_id, recipient_user_id)
);
