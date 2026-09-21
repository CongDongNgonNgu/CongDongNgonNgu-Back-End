DO $$ BEGIN
  CREATE TYPE exchange_report_category AS ENUM (
    'SPAM',
    'HARASSMENT',
    'INAPPROPRIATE_CONTENT',
    'IMPERSONATION',
    'SAFETY_CONCERN',
    'OTHER'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE exchange_report_state AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS language_exchange_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT language_exchange_blocks_actor_check
    CHECK (blocker_user_id <> blocked_user_id),
  CONSTRAINT language_exchange_blocks_actor_target_unique
    UNIQUE (blocker_user_id, blocked_user_id)
);

CREATE INDEX IF NOT EXISTS language_exchange_blocks_blocked_idx
  ON language_exchange_blocks (blocked_user_id, blocker_user_id);

CREATE TABLE IF NOT EXISTS language_exchange_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category exchange_report_category NOT NULL,
  context varchar(1000),
  state exchange_report_state NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT language_exchange_reports_actor_check
    CHECK (reporter_user_id <> target_user_id),
  CONSTRAINT language_exchange_reports_context_check
    CHECK (context IS NULL OR (char_length(context) BETWEEN 1 AND 1000 AND length(btrim(context)) > 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS language_exchange_reports_unique_category_idx
  ON language_exchange_reports (reporter_user_id, target_user_id, category);

CREATE INDEX IF NOT EXISTS language_exchange_reports_target_idx
  ON language_exchange_reports (target_user_id, state, created_at DESC);

CREATE INDEX IF NOT EXISTS language_exchange_reports_reporter_idx
  ON language_exchange_reports (reporter_user_id, created_at DESC);
