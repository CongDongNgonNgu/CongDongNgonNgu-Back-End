-- Stable direct history is independent of the removable Exchange connection row.
CREATE TABLE direct_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_a_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_b_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  change_version bigint NOT NULL DEFAULT 0 CHECK (change_version >= 0),
  last_read_a bigint NOT NULL DEFAULT 0 CHECK (last_read_a >= 0 AND last_read_a < next_sequence),
  last_read_b bigint NOT NULL DEFAULT 0 CHECK (last_read_b >= 0 AND last_read_b < next_sequence),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT direct_conversations_ordered_pair CHECK (participant_a_id < participant_b_id),
  CONSTRAINT direct_conversations_pair_unique UNIQUE (participant_a_id, participant_b_id),
  CONSTRAINT direct_conversations_identity_pair_unique UNIQUE (id, participant_a_id, participant_b_id)
);

CREATE INDEX direct_conversations_a_updated_idx
  ON direct_conversations (participant_a_id, updated_at DESC, id DESC);
CREATE INDEX direct_conversations_b_updated_idx
  ON direct_conversations (participant_b_id, updated_at DESC, id DESC);

CREATE TABLE direct_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  -- Composite FK plus CHECK enforce the real sender pair without cross-row triggers.
  participant_a_id uuid NOT NULL,
  participant_b_id uuid NOT NULL,
  sender_user_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  client_message_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT direct_messages_conversation_pair_fk
    FOREIGN KEY (conversation_id, participant_a_id, participant_b_id)
    REFERENCES direct_conversations (id, participant_a_id, participant_b_id) ON DELETE CASCADE,
  CONSTRAINT direct_messages_sender_participant
    CHECK (sender_user_id = participant_a_id OR sender_user_id = participant_b_id),
  CONSTRAINT direct_messages_sequence_unique UNIQUE (conversation_id, sequence),
  CONSTRAINT direct_messages_idempotency_unique UNIQUE (conversation_id, sender_user_id, client_message_id)
);

CREATE INDEX direct_messages_sender_sequence_idx ON direct_messages (conversation_id, sender_user_id, sequence);
