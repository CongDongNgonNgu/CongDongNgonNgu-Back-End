DO $$ BEGIN
  CREATE TYPE exchange_connection_status AS ENUM ('PENDING', 'CONNECTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS language_exchange_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_a_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_b_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status exchange_connection_status NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT language_exchange_connections_pair_order_check
    CHECK (participant_a_id < participant_b_id),
  CONSTRAINT language_exchange_connections_requester_check
    CHECK (requester_id = participant_a_id OR requester_id = participant_b_id),
  CONSTRAINT language_exchange_connections_pair_unique
    UNIQUE (participant_a_id, participant_b_id)
);

CREATE INDEX IF NOT EXISTS language_exchange_connections_requester_idx
  ON language_exchange_connections (requester_id, status);

CREATE INDEX IF NOT EXISTS language_exchange_connections_participant_b_idx
  ON language_exchange_connections (participant_b_id, status);
