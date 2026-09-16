DO $$ BEGIN
  CREATE TYPE phase06_contribution_event_type AS ENUM (
    'STRUCTURED_RESPONSE_CREATED',
    'RESPONSE_ACCEPTED',
    'ACCEPTANCE_REVOKED',
    'STRUCTURED_RESPONSE_MODERATED',
    'LIBRARY_CANDIDATE_CREATED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE phase06_library_candidate_state AS ENUM (
    'PENDING_REVIEW',
    'INVALIDATED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS community_library_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_post_id uuid NOT NULL REFERENCES community_posts(id) ON DELETE RESTRICT,
  source_response_id uuid NOT NULL,
  contributor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_language_id uuid NOT NULL REFERENCES languages(id) ON DELETE RESTRICT,
  response_kind phase06_structured_response_kind NOT NULL,
  source_text text NOT NULL,
  corrected_text text,
  answer_text text,
  explanation text,
  acceptance_id uuid NOT NULL REFERENCES community_structured_response_acceptances(id) ON DELETE RESTRICT,
  accepted_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  accepted_at timestamptz NOT NULL,
  candidate_created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state phase06_library_candidate_state NOT NULL DEFAULT 'PENDING_REVIEW',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,
  invalidation_reason varchar(80),
  CONSTRAINT community_library_candidate_response_fk
    FOREIGN KEY (source_response_id, source_post_id)
    REFERENCES community_structured_responses(id, parent_post_id)
    ON DELETE RESTRICT,
  CONSTRAINT community_library_candidate_variant_check CHECK (
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
  CONSTRAINT community_library_candidate_source_check CHECK (
    char_length(source_text) BETWEEN 1 AND 20000
    AND char_length(regexp_replace(source_text, '[[:space:]]', '', 'g')) > 0
  ),
  CONSTRAINT community_library_candidate_corrected_check CHECK (
    corrected_text IS NULL OR (
      char_length(corrected_text) BETWEEN 1 AND 20000
      AND char_length(regexp_replace(corrected_text, '[[:space:]]', '', 'g')) > 0
    )
  ),
  CONSTRAINT community_library_candidate_answer_check CHECK (
    answer_text IS NULL OR (
      char_length(answer_text) BETWEEN 1 AND 20000
      AND char_length(regexp_replace(answer_text, '[[:space:]]', '', 'g')) > 0
    )
  ),
  CONSTRAINT community_library_candidate_explanation_check CHECK (
    explanation IS NULL OR (
      char_length(explanation) BETWEEN 1 AND 5000
      AND char_length(regexp_replace(explanation, '[[:space:]]', '', 'g')) > 0
    )
  ),
  CONSTRAINT community_library_candidate_state_check CHECK (
    (state = 'PENDING_REVIEW'::phase06_library_candidate_state
      AND invalidated_at IS NULL
      AND invalidation_reason IS NULL)
    OR
    (state = 'INVALIDATED'::phase06_library_candidate_state
      AND invalidated_at IS NOT NULL
      AND invalidation_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS community_library_candidates_active_response_idx
  ON community_library_candidates (source_response_id)
  WHERE state = 'PENDING_REVIEW'::phase06_library_candidate_state;

CREATE INDEX IF NOT EXISTS community_library_candidates_pending_idx
  ON community_library_candidates (state, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS community_library_candidates_source_post_idx
  ON community_library_candidates (source_post_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS phase06_contribution_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type phase06_contribution_event_type NOT NULL,
  idempotency_key text NOT NULL,
  aggregate_id uuid NOT NULL,
  parent_post_id uuid NOT NULL REFERENCES community_posts(id) ON DELETE RESTRICT,
  response_id uuid,
  candidate_id uuid REFERENCES community_library_candidates(id) ON DELETE RESTRICT,
  acceptance_id uuid REFERENCES community_structured_response_acceptances(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  contributor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  response_kind phase06_structured_response_kind,
  moderation_state community_moderation_state,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phase06_contribution_events_idempotency_unique
    UNIQUE (idempotency_key),
  CONSTRAINT phase06_contribution_event_response_fk
    FOREIGN KEY (response_id, parent_post_id)
    REFERENCES community_structured_responses(id, parent_post_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS phase06_contribution_events_parent_idx
  ON phase06_contribution_events (parent_post_id, occurred_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS phase06_contribution_events_response_idx
  ON phase06_contribution_events (response_id, occurred_at ASC, id ASC)
  WHERE response_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS phase06_contribution_events_candidate_idx
  ON phase06_contribution_events (candidate_id, occurred_at ASC, id ASC)
  WHERE candidate_id IS NOT NULL;
