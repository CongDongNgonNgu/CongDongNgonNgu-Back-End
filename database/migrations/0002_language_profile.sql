CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
  CREATE TYPE language_direction AS ENUM ('ltr', 'rtl');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE declared_language_proficiency AS ENUM ('NATIVE', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE assessed_language_proficiency AS ENUM ('A1', 'A2', 'B1', 'B2', 'C1', 'C2');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE language_visibility AS ENUM ('PUBLIC', 'PRIVATE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE profile_skill AS ENUM ('speaking', 'listening', 'reading', 'writing', 'grammar', 'vocabulary');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS languages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(35) NOT NULL UNIQUE,
  slug varchar(64) NOT NULL UNIQUE,
  native_name varchar(120) NOT NULL,
  english_name varchar(120) NOT NULL,
  vietnamese_name varchar(120) NOT NULL,
  direction language_direction NOT NULL DEFAULT 'ltr',
  active boolean NOT NULL DEFAULT true,
  launch boolean NOT NULL DEFAULT false,
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT languages_code_lowercase CHECK (code = lower(code)),
  CONSTRAINT languages_slug_safe CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT languages_sort_order_nonnegative CHECK (sort_order >= 0)
);

CREATE INDEX IF NOT EXISTS languages_active_sort_idx
  ON languages(active, sort_order, english_name);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_profiles_timezone_nonempty CHECK (timezone IS NULL OR length(timezone) > 0)
);

CREATE TABLE IF NOT EXISTS user_languages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language_id uuid NOT NULL REFERENCES languages(id) ON DELETE RESTRICT,
  is_native boolean NOT NULL DEFAULT false,
  is_known boolean NOT NULL DEFAULT false,
  is_learning boolean NOT NULL DEFAULT false,
  declared_proficiency declared_language_proficiency NOT NULL,
  assessed_proficiency assessed_language_proficiency,
  is_primary_learning_target boolean NOT NULL DEFAULT false,
  visibility language_visibility NOT NULL DEFAULT 'PUBLIC',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_languages_one_per_language UNIQUE (user_id, language_id),
  CONSTRAINT user_languages_has_role CHECK (is_native OR is_known OR is_learning),
  CONSTRAINT user_languages_native_matches_level CHECK ((declared_proficiency = 'NATIVE') = is_native),
  CONSTRAINT user_languages_primary_is_learning CHECK (NOT is_primary_learning_target OR is_learning)
);

CREATE UNIQUE INDEX IF NOT EXISTS user_languages_one_primary_idx
  ON user_languages(user_id)
  WHERE is_primary_learning_target;

CREATE INDEX IF NOT EXISTS user_languages_user_idx
  ON user_languages(user_id);

CREATE TABLE IF NOT EXISTS user_learning_goals (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_code varchar(64) NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, goal_code),
  CONSTRAINT user_learning_goals_code_safe CHECK (goal_code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT user_learning_goals_sort_nonnegative CHECK (sort_order >= 0)
);

CREATE TABLE IF NOT EXISTS user_profile_skills (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill profile_skill NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, skill)
);

CREATE TABLE IF NOT EXISTS user_profile_interests (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interest_code varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, interest_code),
  CONSTRAINT user_profile_interests_code_nonempty CHECK (length(interest_code) > 0)
);

CREATE TABLE IF NOT EXISTS user_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL,
  start_minute smallint NOT NULL,
  end_minute smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_availability_day_range CHECK (day_of_week BETWEEN 1 AND 7),
  CONSTRAINT user_availability_start_range CHECK (start_minute BETWEEN 0 AND 1439),
  CONSTRAINT user_availability_end_range CHECK (end_minute BETWEEN 1 AND 1440),
  CONSTRAINT user_availability_positive_range CHECK (start_minute < end_minute),
  CONSTRAINT user_availability_no_overlap
    EXCLUDE USING gist (
      user_id WITH =,
      day_of_week WITH =,
      int4range(start_minute, end_minute, '[)') WITH &&
    )
);

CREATE INDEX IF NOT EXISTS user_availability_user_idx
  ON user_availability(user_id, day_of_week, start_minute);
