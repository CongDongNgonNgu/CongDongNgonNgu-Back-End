DO $$ BEGIN
  CREATE TYPE exchange_language_direction AS ENUM ('OFFER', 'WANT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE exchange_visibility_mode AS ENUM ('HIDDEN', 'SUMMARY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE exchange_contact_permission AS ENUM ('NO_CONTACT', 'RELATIONSHIP_GATED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS user_languages_user_id_id_idx
  ON user_languages (user_id, id);

CREATE TABLE IF NOT EXISTS language_exchange_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  exchange_opt_in boolean NOT NULL DEFAULT false,
  discoverable boolean NOT NULL DEFAULT false,
  timezone_visibility exchange_visibility_mode NOT NULL DEFAULT 'HIDDEN',
  availability_visibility exchange_visibility_mode NOT NULL DEFAULT 'HIDDEN',
  contact_permission exchange_contact_permission NOT NULL DEFAULT 'NO_CONTACT',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS language_exchange_discovery_idx
  ON language_exchange_preferences (exchange_opt_in, discoverable, user_id);

CREATE TABLE IF NOT EXISTS language_exchange_languages (
  user_id uuid NOT NULL,
  user_language_id uuid NOT NULL,
  direction exchange_language_direction NOT NULL,
  PRIMARY KEY (user_id, user_language_id, direction),
  CONSTRAINT language_exchange_languages_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT language_exchange_languages_relation_fk
    FOREIGN KEY (user_id, user_language_id)
    REFERENCES user_languages(user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS language_exchange_languages_user_idx
  ON language_exchange_languages (user_id, direction, user_language_id);

CREATE INDEX IF NOT EXISTS language_exchange_languages_match_idx
  ON language_exchange_languages (direction, user_language_id, user_id);

CREATE TABLE IF NOT EXISTS language_exchange_partner_levels (
  user_id uuid NOT NULL REFERENCES language_exchange_preferences(user_id) ON DELETE CASCADE,
  level varchar(2) NOT NULL,
  PRIMARY KEY (user_id, level),
  CONSTRAINT language_exchange_partner_level_check
    CHECK (level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2'))
);

CREATE INDEX IF NOT EXISTS language_exchange_partner_levels_match_idx
  ON language_exchange_partner_levels (level, user_id);

CREATE TABLE IF NOT EXISTS language_exchange_goals (
  user_id uuid NOT NULL,
  goal_code varchar(64) NOT NULL,
  PRIMARY KEY (user_id, goal_code),
  CONSTRAINT language_exchange_goals_user_fk
    FOREIGN KEY (user_id) REFERENCES language_exchange_preferences(user_id) ON DELETE CASCADE,
  CONSTRAINT language_exchange_goals_profile_fk
    FOREIGN KEY (user_id, goal_code)
    REFERENCES user_learning_goals(user_id, goal_code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS language_exchange_goals_match_idx
  ON language_exchange_goals (goal_code, user_id);

CREATE TABLE IF NOT EXISTS language_exchange_interests (
  user_id uuid NOT NULL,
  interest_code varchar(64) NOT NULL,
  PRIMARY KEY (user_id, interest_code),
  CONSTRAINT language_exchange_interests_user_fk
    FOREIGN KEY (user_id) REFERENCES language_exchange_preferences(user_id) ON DELETE CASCADE,
  CONSTRAINT language_exchange_interests_profile_fk
    FOREIGN KEY (user_id, interest_code)
    REFERENCES user_profile_interests(user_id, interest_code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS language_exchange_interests_match_idx
  ON language_exchange_interests (interest_code, user_id);

INSERT INTO language_exchange_preferences (user_id)
SELECT id FROM users
ON CONFLICT (user_id) DO NOTHING;
