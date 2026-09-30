DO $$ BEGIN
  CREATE TYPE reputation_system AS ENUM ('learning_xp', 'community_reputation');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE reputation_source_type AS ENUM (
    'USEFUL_ANSWER_ACCEPTED',
    'CORRECTION_ACCEPTED',
    'TRANSLATION_VERIFIED',
    'RESOURCE_VERIFIED',
    'REVIEW_VERIFICATION',
    'PRACTICE_COMPLETED',
    'LEARNING_SESSION_COMPLETED',
    'VOCABULARY_MILESTONE',
    'QUIZ_MILESTONE'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS reputation_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  system reputation_system NOT NULL,
  source_type reputation_source_type NOT NULL,
  source_id uuid NOT NULL,
  delta integer NOT NULL,
  reason varchar(240) NOT NULL,
  rule_version varchar(64) NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  reversal_of_entry_id uuid REFERENCES reputation_ledger_entries(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reputation_ledger_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT reputation_ledger_delta_check CHECK (delta <> 0 AND delta BETWEEN -100000 AND 100000),
  CONSTRAINT reputation_ledger_reason_check CHECK (
    char_length(reason) BETWEEN 1 AND 240 AND char_length(btrim(reason)) > 0
  ),
  CONSTRAINT reputation_ledger_rule_version_check CHECK (
    char_length(rule_version) BETWEEN 1 AND 64 AND char_length(btrim(rule_version)) > 0
  ),
  CONSTRAINT reputation_ledger_idempotency_key_check CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 200 AND char_length(btrim(idempotency_key)) > 0
  ),
  CONSTRAINT reputation_ledger_reversal_self_check CHECK (
    reversal_of_entry_id IS NULL OR reversal_of_entry_id <> id
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS reputation_ledger_reversal_unique_idx
  ON reputation_ledger_entries (reversal_of_entry_id)
  WHERE reversal_of_entry_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS reputation_ledger_user_balance_idx
  ON reputation_ledger_entries (user_id, system, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS reputation_ledger_source_idx
  ON reputation_ledger_entries (source_type, source_id, created_at DESC);
