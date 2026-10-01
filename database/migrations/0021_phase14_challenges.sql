BEGIN;

DO $$ BEGIN
  CREATE TYPE challenge_type AS ENUM (
    'SPEAKING',
    'SENTENCE_PRACTICE',
    'PRONUNCIATION',
    'VOCABULARY',
    'COMMUNITY'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE challenge_goal_unit AS ENUM ('ACTIVITIES', 'MINUTES', 'ITEMS');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE challenge_activity_type AS ENUM (
    'SPEAKING_ROOM_ATTENDANCE',
    'PRACTICE_COMPLETED',
    'VOCABULARY_MILESTONE',
    'COMMUNITY_CONTRIBUTION'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE challenge_status AS ENUM ('DRAFT', 'ACTIVE', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE challenge_participation_status AS ENUM ('JOINED', 'LEFT', 'COMPLETED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  title varchar(160) NOT NULL,
  description varchar(2000) NOT NULL,
  challenge_type challenge_type NOT NULL,
  language_id uuid NOT NULL REFERENCES languages(id) ON DELETE RESTRICT,
  level varchar(8),
  topic varchar(80),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone varchar(64) NOT NULL,
  goal_unit challenge_goal_unit NOT NULL,
  goal_target integer NOT NULL,
  eligible_activity_types challenge_activity_type[] NOT NULL,
  rule_version varchar(64) NOT NULL,
  reward_event_type varchar(96),
  reward_rule_version varchar(64),
  status challenge_status NOT NULL DEFAULT 'DRAFT',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT challenges_title_check CHECK (length(btrim(title)) BETWEEN 3 AND 160),
  CONSTRAINT challenges_description_check CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  CONSTRAINT challenges_level_check CHECK (level IS NULL OR level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  CONSTRAINT challenges_topic_check CHECK (topic IS NULL OR length(btrim(topic)) BETWEEN 1 AND 80),
  CONSTRAINT challenges_time_check CHECK (ends_at > starts_at),
  CONSTRAINT challenges_timezone_check CHECK (length(btrim(timezone)) BETWEEN 1 AND 64),
  CONSTRAINT challenges_goal_target_check CHECK (goal_target BETWEEN 1 AND 1000000),
  CONSTRAINT challenges_activity_rules_check CHECK (cardinality(eligible_activity_types) BETWEEN 1 AND 8),
  CONSTRAINT challenges_rule_version_check CHECK (rule_version ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'),
  CONSTRAINT challenges_reward_pair_check CHECK (
    (reward_event_type IS NULL AND reward_rule_version IS NULL)
    OR (reward_event_type IS NOT NULL AND reward_rule_version IS NOT NULL)
  ),
  CONSTRAINT challenges_reward_event_check CHECK (
    reward_event_type IS NULL OR reward_event_type ~ '^[a-z][a-z0-9._:-]{2,95}$'
  ),
  CONSTRAINT challenges_reward_rule_check CHECK (
    reward_rule_version IS NULL OR reward_rule_version ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'
  )
);

CREATE INDEX IF NOT EXISTS challenges_public_listing_idx
  ON challenges (status, language_id, starts_at, id);

CREATE INDEX IF NOT EXISTS challenges_creator_idx
  ON challenges (created_by_user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS challenge_participations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status challenge_participation_status NOT NULL DEFAULT 'JOINED',
  progress_value integer NOT NULL DEFAULT 0,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT challenge_participations_unique_user UNIQUE (challenge_id, user_id),
  CONSTRAINT challenge_participations_progress_check CHECK (progress_value >= 0),
  CONSTRAINT challenge_participations_left_state_check CHECK (
    (status = 'LEFT' AND left_at IS NOT NULL)
    OR (status <> 'LEFT' AND left_at IS NULL)
  ),
  CONSTRAINT challenge_participations_completed_state_check CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL)
    OR (status <> 'COMPLETED' AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS challenge_participations_user_idx
  ON challenge_participations (user_id, status, updated_at DESC, challenge_id);

CREATE TABLE IF NOT EXISTS challenge_progress_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  activity_type challenge_activity_type NOT NULL,
  source_id varchar(200) NOT NULL,
  units integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  rule_version varchar(64) NOT NULL,
  idempotency_key varchar(300) NOT NULL,
  fingerprint varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT challenge_progress_events_units_check CHECK (units BETWEEN 1 AND 1000),
  CONSTRAINT challenge_progress_events_source_check CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  CONSTRAINT challenge_progress_events_rule_check CHECK (rule_version ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'),
  CONSTRAINT challenge_progress_events_fingerprint_check CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT challenge_progress_events_idempotency_unique UNIQUE (challenge_id, user_id, idempotency_key),
  CONSTRAINT challenge_progress_events_source_unique UNIQUE (challenge_id, user_id, activity_type, source_id)
);

CREATE INDEX IF NOT EXISTS challenge_progress_events_user_time_idx
  ON challenge_progress_events (user_id, occurred_at DESC, id DESC);

COMMIT;
