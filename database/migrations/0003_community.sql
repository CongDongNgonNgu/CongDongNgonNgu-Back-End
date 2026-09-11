DO $$ BEGIN
  CREATE TYPE community_post_type AS ENUM (
    'DISCUSSION',
    'QUESTION',
    'RESOURCE',
    'LEARNING_JOURNAL',
    'CULTURE',
    'PRONUNCIATION_REQUEST',
    'CORRECTION_REQUEST',
    'CHALLENGE'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE community_cefr_level AS ENUM ('A1', 'A2', 'B1', 'B2', 'C1', 'C2');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE community_post_visibility AS ENUM ('PUBLIC', 'PRIVATE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE community_moderation_state AS ENUM ('ACTIVE', 'HIDDEN', 'DELETED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE community_reaction_type AS ENUM ('HELPFUL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE community_report_category AS ENUM (
    'SPAM',
    'HARASSMENT',
    'HATE',
    'MISINFORMATION',
    'SEXUAL_CONTENT',
    'OTHER'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE community_report_state AS ENUM ('OPEN', 'DISMISSED', 'ACTIONED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS community_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_language_id uuid NOT NULL REFERENCES languages(id) ON DELETE RESTRICT,
  post_type community_post_type NOT NULL,
  content text NOT NULL,
  cefr_level community_cefr_level,
  topic varchar(80),
  visibility community_post_visibility NOT NULL DEFAULT 'PUBLIC',
  moderation_state community_moderation_state NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT community_posts_content_check
    CHECK (char_length(content) BETWEEN 1 AND 20000 AND length(btrim(content)) > 0),
  CONSTRAINT community_posts_topic_check
    CHECK (topic IS NULL OR char_length(topic) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS community_posts_feed_idx
  ON community_posts (visibility, moderation_state, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS community_posts_language_feed_idx
  ON community_posts (target_language_id, visibility, moderation_state, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS community_posts_author_idx
  ON community_posts (author_user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS community_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES community_posts(id) ON DELETE RESTRICT,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  parent_comment_id uuid REFERENCES community_comments(id) ON DELETE RESTRICT,
  depth smallint NOT NULL DEFAULT 0,
  content text NOT NULL,
  moderation_state community_moderation_state NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT community_comments_depth_check CHECK (depth IN (0, 1)),
  CONSTRAINT community_comments_parent_depth_check CHECK (
    (depth = 0 AND parent_comment_id IS NULL) OR
    (depth = 1 AND parent_comment_id IS NOT NULL)
  ),
  CONSTRAINT community_comments_content_check
    CHECK (char_length(content) BETWEEN 1 AND 5000 AND length(btrim(content)) > 0)
);

CREATE INDEX IF NOT EXISTS community_comments_post_idx
  ON community_comments (post_id, parent_comment_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS community_reactions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  post_id uuid NOT NULL REFERENCES community_posts(id) ON DELETE RESTRICT,
  reaction_type community_reaction_type NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id, reaction_type)
);

CREATE INDEX IF NOT EXISTS community_reactions_post_idx
  ON community_reactions (post_id, reaction_type);

CREATE TABLE IF NOT EXISTS community_saved_posts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  post_id uuid NOT NULL REFERENCES community_posts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX IF NOT EXISTS community_saved_posts_user_idx
  ON community_saved_posts (user_id, created_at DESC, post_id DESC);

CREATE TABLE IF NOT EXISTS community_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_post_id uuid REFERENCES community_posts(id) ON DELETE RESTRICT,
  target_comment_id uuid REFERENCES community_comments(id) ON DELETE RESTRICT,
  category community_report_category NOT NULL,
  details varchar(1000),
  state community_report_state NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_reports_one_target_check
    CHECK ((target_post_id IS NOT NULL) <> (target_comment_id IS NOT NULL)),
  CONSTRAINT community_reports_details_check
    CHECK (details IS NULL OR char_length(details) BETWEEN 1 AND 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS community_reports_post_unique_idx
  ON community_reports (reporter_user_id, target_post_id, category)
  WHERE target_post_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS community_reports_comment_unique_idx
  ON community_reports (reporter_user_id, target_comment_id, category)
  WHERE target_comment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS community_reports_post_idx
  ON community_reports (target_post_id, created_at DESC)
  WHERE target_post_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS community_reports_comment_idx
  ON community_reports (target_comment_id, created_at DESC)
  WHERE target_comment_id IS NOT NULL;
