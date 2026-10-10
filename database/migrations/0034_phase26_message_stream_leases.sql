ALTER TABLE direct_message_rate_limits DROP CONSTRAINT direct_message_rate_limits_bucket_check;
ALTER TABLE direct_message_rate_limits ADD CONSTRAINT direct_message_rate_limits_bucket_check
  CHECK (bucket IN ('SEND_MINUTE','SEND_HOUR','STREAM_MINUTE'));

-- Ephemeral ownership, never message content or bearer credentials.
CREATE TABLE direct_message_stream_leases (
  id uuid PRIMARY KEY,
  owner_token uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX direct_message_stream_actor_expiry_idx ON direct_message_stream_leases(actor_id,expires_at);
CREATE INDEX direct_message_stream_expiry_idx ON direct_message_stream_leases(expires_at);
