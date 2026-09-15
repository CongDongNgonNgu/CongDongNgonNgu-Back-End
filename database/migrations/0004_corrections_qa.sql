DO $$ BEGIN
  CREATE TYPE phase06_correction_intent AS ENUM (
    'GRAMMAR',
    'STYLE',
    'NATURALNESS',
    'PRONUNCIATION'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE phase06_structured_response_kind AS ENUM (
    'CORRECTION_PROPOSAL',
    'QA_ANSWER'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE phase06_structured_response_vote_type AS ENUM ('HELPFUL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS community_correction_requests (
  post_id uuid PRIMARY KEY REFERENCES community_posts(id) ON DELETE RESTRICT,
  original_text text NOT NULL,
  correction_intent phase06_correction_intent NOT NULL,
  context text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_correction_original_check
    CHECK (
      char_length(original_text) BETWEEN 1 AND 20000
      AND length(btrim(original_text)) > 0
    ),
  CONSTRAINT community_correction_context_check
    CHECK (context IS NULL OR (
      char_length(context) BETWEEN 1 AND 5000
      AND length(btrim(context)) > 0
    ))
);

CREATE INDEX IF NOT EXISTS community_correction_requests_created_idx
  ON community_correction_requests (created_at DESC, post_id DESC);

CREATE OR REPLACE FUNCTION phase06_prevent_correction_original_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.original_text IS DISTINCT FROM OLD.original_text THEN
    RAISE EXCEPTION 'CORRECTION_ORIGINAL_IMMUTABLE'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS community_correction_original_immutable
  ON community_correction_requests;

CREATE TRIGGER community_correction_original_immutable
  BEFORE UPDATE ON community_correction_requests
  FOR EACH ROW
  EXECUTE FUNCTION phase06_prevent_correction_original_update();

CREATE TABLE IF NOT EXISTS community_structured_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_post_id uuid NOT NULL REFERENCES community_posts(id) ON DELETE RESTRICT,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  response_kind phase06_structured_response_kind NOT NULL,
  corrected_text text,
  answer_text text,
  explanation text,
  moderation_state community_moderation_state NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT community_structured_response_variant_check CHECK (
    (
      response_kind = 'CORRECTION_PROPOSAL'::phase06_structured_response_kind
      AND corrected_text IS NOT NULL
      AND answer_text IS NULL
    )
    OR
    (
      response_kind = 'QA_ANSWER'::phase06_structured_response_kind
      AND corrected_text IS NULL
      AND answer_text IS NOT NULL
    )
  ),
  CONSTRAINT community_structured_response_corrected_check CHECK (
    corrected_text IS NULL OR (
      char_length(corrected_text) BETWEEN 1 AND 20000
      AND length(btrim(corrected_text)) > 0
    )
  ),
  CONSTRAINT community_structured_response_answer_check CHECK (
    answer_text IS NULL OR (
      char_length(answer_text) BETWEEN 1 AND 20000
      AND length(btrim(answer_text)) > 0
    )
  ),
  CONSTRAINT community_structured_response_explanation_check CHECK (
    explanation IS NULL OR (
      char_length(explanation) BETWEEN 1 AND 5000
      AND length(btrim(explanation)) > 0
    )
  ),
  CONSTRAINT community_structured_response_id_parent_unique
    UNIQUE (id, parent_post_id)
);

CREATE INDEX IF NOT EXISTS community_structured_responses_parent_idx
  ON community_structured_responses (parent_post_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS community_structured_responses_author_idx
  ON community_structured_responses (author_user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS community_structured_response_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_post_id uuid NOT NULL REFERENCES community_posts(id) ON DELETE RESTRICT,
  response_id uuid NOT NULL,
  accepted_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT community_response_acceptance_response_fk
    FOREIGN KEY (response_id, parent_post_id)
    REFERENCES community_structured_responses(id, parent_post_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS community_response_active_acceptance_idx
  ON community_structured_response_acceptances (parent_post_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS community_response_acceptance_response_idx
  ON community_structured_response_acceptances (response_id, accepted_at DESC);

CREATE TABLE IF NOT EXISTS community_structured_response_votes (
  response_id uuid NOT NULL REFERENCES community_structured_responses(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  vote_type phase06_structured_response_vote_type NOT NULL DEFAULT 'HELPFUL',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (response_id, user_id)
);

CREATE INDEX IF NOT EXISTS community_structured_response_votes_user_idx
  ON community_structured_response_votes (user_id, created_at DESC, response_id);
