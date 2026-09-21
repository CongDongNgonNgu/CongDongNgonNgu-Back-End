DO $$ BEGIN
  CREATE TYPE library_resource_type AS ENUM (
    'VOCABULARY',
    'SENTENCE',
    'TRANSLATION',
    'GRAMMAR_ITEM',
    'DIALOGUE',
    'IDIOM',
    'SLANG',
    'CULTURAL_NOTE',
    'PRONUNCIATION',
    'LEARNING_COLLECTION'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE library_review_state AS ENUM (
    'DRAFT',
    'COMMUNITY_REVIEW',
    'VERIFIED',
    'REJECTED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE library_source_type AS ENUM (
    'COMMUNITY_POST',
    'PHASE06_LIBRARY_CANDIDATE',
    'OPEN_DATASET',
    'MANUAL_ENTRY',
    'ORIGINAL_AUTHOR'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE library_review_action AS ENUM (
    'SUBMIT',
    'VERIFY',
    'REJECT',
    'INVALIDATE',
    'REOPEN'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS library_licenses (
  license_key varchar(80) PRIMARY KEY,
  display_name varchar(160) NOT NULL,
  canonical_url varchar(2048) NOT NULL,
  attribution_required boolean NOT NULL,
  redistribution_allowed boolean,
  derivative_constraints varchar(2000),
  active boolean NOT NULL DEFAULT true,
  source_note varchar(2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_license_key_check
    CHECK (license_key ~ '^[A-Z0-9][A-Z0-9._-]{0,79}$'),
  CONSTRAINT library_license_display_name_check
    CHECK (char_length(display_name) BETWEEN 1 AND 160 AND length(btrim(display_name)) > 0),
  CONSTRAINT library_license_url_check
    CHECK (canonical_url ~ '^https?://'),
  CONSTRAINT library_license_constraints_check
    CHECK (derivative_constraints IS NULL OR (
      char_length(derivative_constraints) BETWEEN 1 AND 2000
      AND length(btrim(derivative_constraints)) > 0
    )),
  CONSTRAINT library_license_source_note_check
    CHECK (source_note IS NULL OR (
      char_length(source_note) BETWEEN 1 AND 2000
      AND length(btrim(source_note)) > 0
    ))
);

CREATE INDEX IF NOT EXISTS library_licenses_active_idx
  ON library_licenses (active, license_key);

CREATE TABLE IF NOT EXISTS library_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type library_resource_type NOT NULL,
  primary_language_id uuid NOT NULL REFERENCES languages(id) ON DELETE RESTRICT,
  secondary_language_id uuid REFERENCES languages(id) ON DELETE RESTRICT,
  cefr_level community_cefr_level,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  visibility community_post_visibility NOT NULL DEFAULT 'PRIVATE',
  moderation_state community_moderation_state NOT NULL DEFAULT 'ACTIVE',
  review_state library_review_state NOT NULL DEFAULT 'DRAFT',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  CONSTRAINT library_resource_languages_distinct_check
    CHECK (secondary_language_id IS NULL OR secondary_language_id <> primary_language_id),
  CONSTRAINT library_resource_review_metadata_check
    CHECK (
      (
        review_state IN ('DRAFT'::library_review_state, 'COMMUNITY_REVIEW'::library_review_state)
        AND reviewed_by_user_id IS NULL
        AND reviewed_at IS NULL
      )
      OR
      (
        review_state IN ('VERIFIED'::library_review_state, 'REJECTED'::library_review_state)
        AND reviewed_by_user_id IS NOT NULL
        AND reviewed_at IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS library_resources_public_idx
  ON library_resources (
    visibility,
    moderation_state,
    review_state,
    primary_language_id,
    created_at DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS library_resources_review_idx
  ON library_resources (review_state, updated_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS library_resources_creator_idx
  ON library_resources (created_by_user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS library_resource_topics (
  resource_id uuid NOT NULL REFERENCES library_resources(id) ON DELETE CASCADE,
  topic varchar(80) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, topic),
  CONSTRAINT library_resource_topic_check
    CHECK (char_length(topic) BETWEEN 1 AND 80 AND length(btrim(topic)) > 0)
);

CREATE INDEX IF NOT EXISTS library_resource_topics_topic_idx
  ON library_resource_topics (topic, resource_id);

CREATE TABLE IF NOT EXISTS library_resource_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES library_resources(id) ON DELETE CASCADE,
  source_type library_source_type NOT NULL,
  source_id varchar(255) NOT NULL,
  source_url varchar(2048),
  license_key varchar(80) NOT NULL REFERENCES library_licenses(license_key) ON DELETE RESTRICT,
  attribution varchar(2000) NOT NULL,
  original_author_reference varchar(255),
  original_contributor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  import_batch varchar(120),
  transformation_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_post_id uuid REFERENCES community_posts(id) ON DELETE RESTRICT,
  source_response_id uuid,
  source_candidate_id uuid REFERENCES community_library_candidates(id) ON DELETE RESTRICT,
  source_acceptance_id uuid REFERENCES community_structured_response_acceptances(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_resource_provenance_source_unique
    UNIQUE (resource_id, source_type, source_id),
  CONSTRAINT library_resource_provenance_source_id_check
    CHECK (char_length(source_id) BETWEEN 1 AND 255 AND length(btrim(source_id)) > 0),
  CONSTRAINT library_resource_provenance_url_check
    CHECK (source_url IS NULL OR source_url ~ '^https?://'),
  CONSTRAINT library_resource_provenance_attribution_check
    CHECK (char_length(attribution) BETWEEN 1 AND 2000 AND length(btrim(attribution)) > 0),
  CONSTRAINT library_resource_provenance_author_check
    CHECK (original_author_reference IS NULL OR (
      char_length(original_author_reference) BETWEEN 1 AND 255
      AND length(btrim(original_author_reference)) > 0
    )),
  CONSTRAINT library_resource_provenance_batch_check
    CHECK (import_batch IS NULL OR (
      char_length(import_batch) BETWEEN 1 AND 120
      AND length(btrim(import_batch)) > 0
    )),
  CONSTRAINT library_resource_provenance_history_check
    CHECK (jsonb_typeof(transformation_history) = 'array'),
  CONSTRAINT library_resource_provenance_phase06_pair_check
    CHECK ((source_post_id IS NULL) = (source_response_id IS NULL)),
  CONSTRAINT library_resource_provenance_response_fk
    FOREIGN KEY (source_response_id, source_post_id)
    REFERENCES community_structured_responses(id, parent_post_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS library_resource_provenance_resource_idx
  ON library_resource_provenance (resource_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS library_resource_provenance_source_idx
  ON library_resource_provenance (source_type, source_id);

CREATE OR REPLACE FUNCTION library_validate_provenance_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_type = 'PHASE06_LIBRARY_CANDIDATE'::library_source_type THEN
    IF NEW.source_post_id IS NULL
      OR NEW.source_response_id IS NULL
      OR NEW.source_candidate_id IS NULL
      OR NEW.source_acceptance_id IS NULL
      OR NEW.source_id <> NEW.source_candidate_id::text
    THEN
      RAISE EXCEPTION 'LIBRARY_PHASE06_SOURCE_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM community_library_candidates AS candidate
      INNER JOIN community_structured_response_acceptances AS acceptance
        ON acceptance.id = candidate.acceptance_id
       AND acceptance.parent_post_id = candidate.source_post_id
       AND acceptance.response_id = candidate.source_response_id
       AND acceptance.revoked_at IS NULL
      WHERE candidate.id = NEW.source_candidate_id
        AND candidate.source_post_id = NEW.source_post_id
        AND candidate.source_response_id = NEW.source_response_id
        AND candidate.acceptance_id = NEW.source_acceptance_id
        AND candidate.state = 'PENDING_REVIEW'::phase06_library_candidate_state
    ) THEN
      RAISE EXCEPTION 'LIBRARY_PHASE06_SOURCE_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.source_post_id IS NOT NULL
    OR NEW.source_response_id IS NOT NULL
    OR NEW.source_candidate_id IS NOT NULL
    OR NEW.source_acceptance_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'LIBRARY_SOURCE_REFERENCE_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS library_resource_provenance_source_guard
  ON library_resource_provenance;

CREATE TRIGGER library_resource_provenance_source_guard
  BEFORE INSERT OR UPDATE OF source_type, source_id, source_post_id,
    source_response_id, source_candidate_id, source_acceptance_id
  ON library_resource_provenance
  FOR EACH ROW
  EXECUTE FUNCTION library_validate_provenance_source();

CREATE TABLE IF NOT EXISTS library_resource_review_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES library_resources(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  previous_state library_review_state NOT NULL,
  new_state library_review_state NOT NULL,
  action library_review_action NOT NULL,
  note varchar(2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_resource_review_audit_state_change_check
    CHECK (previous_state <> new_state),
  CONSTRAINT library_resource_review_audit_note_check
    CHECK (note IS NULL OR (
      char_length(note) BETWEEN 1 AND 2000
      AND length(btrim(note)) > 0
    )),
  CONSTRAINT library_resource_review_audit_reopen_note_check
    CHECK (
      action <> 'REOPEN'::library_review_action
      OR (
        note IS NOT NULL
        AND char_length(note) BETWEEN 1 AND 2000
        AND length(btrim(note)) > 0
      )
    )
);

CREATE INDEX IF NOT EXISTS library_resource_review_audits_resource_idx
  ON library_resource_review_audits (resource_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS library_vocabularies (
  resource_id uuid PRIMARY KEY REFERENCES library_resources(id) ON DELETE CASCADE,
  term varchar(500) NOT NULL,
  definition text NOT NULL,
  part_of_speech varchar(80),
  example_sentence text,
  CONSTRAINT library_vocabulary_term_check
    CHECK (char_length(term) BETWEEN 1 AND 500 AND length(btrim(term)) > 0),
  CONSTRAINT library_vocabulary_definition_check
    CHECK (char_length(definition) BETWEEN 1 AND 5000 AND length(btrim(definition)) > 0),
  CONSTRAINT library_vocabulary_part_of_speech_check
    CHECK (part_of_speech IS NULL OR (
      char_length(part_of_speech) BETWEEN 1 AND 80 AND length(btrim(part_of_speech)) > 0
    )),
  CONSTRAINT library_vocabulary_example_check
    CHECK (example_sentence IS NULL OR (
      char_length(example_sentence) BETWEEN 1 AND 20000
      AND length(btrim(example_sentence)) > 0
    ))
);

CREATE TABLE IF NOT EXISTS library_sentences (
  resource_id uuid PRIMARY KEY REFERENCES library_resources(id) ON DELETE CASCADE,
  text_content text NOT NULL,
  context text,
  CONSTRAINT library_sentence_text_check
    CHECK (char_length(text_content) BETWEEN 1 AND 20000 AND length(btrim(text_content)) > 0),
  CONSTRAINT library_sentence_context_check
    CHECK (context IS NULL OR (char_length(context) BETWEEN 1 AND 5000 AND length(btrim(context)) > 0))
);

CREATE TABLE IF NOT EXISTS library_translations (
  resource_id uuid PRIMARY KEY REFERENCES library_resources(id) ON DELETE CASCADE,
  source_text text NOT NULL,
  translated_text text NOT NULL,
  CONSTRAINT library_translation_source_check
    CHECK (char_length(source_text) BETWEEN 1 AND 20000 AND length(btrim(source_text)) > 0),
  CONSTRAINT library_translation_target_check
    CHECK (char_length(translated_text) BETWEEN 1 AND 20000 AND length(btrim(translated_text)) > 0)
);

CREATE TABLE IF NOT EXISTS library_grammar_items (
  resource_id uuid PRIMARY KEY REFERENCES library_resources(id) ON DELETE CASCADE,
  title varchar(200) NOT NULL,
  explanation text NOT NULL,
  pattern text,
  example_text text,
  CONSTRAINT library_grammar_title_check
    CHECK (char_length(title) BETWEEN 1 AND 200 AND length(btrim(title)) > 0),
  CONSTRAINT library_grammar_explanation_check
    CHECK (char_length(explanation) BETWEEN 1 AND 10000 AND length(btrim(explanation)) > 0),
  CONSTRAINT library_grammar_pattern_check
    CHECK (pattern IS NULL OR (char_length(pattern) BETWEEN 1 AND 2000 AND length(btrim(pattern)) > 0)),
  CONSTRAINT library_grammar_example_check
    CHECK (example_text IS NULL OR (char_length(example_text) BETWEEN 1 AND 20000 AND length(btrim(example_text)) > 0))
);

CREATE TABLE IF NOT EXISTS library_dialogues (
  resource_id uuid PRIMARY KEY REFERENCES library_resources(id) ON DELETE CASCADE,
  title varchar(200) NOT NULL,
  turns jsonb NOT NULL,
  CONSTRAINT library_dialogue_title_check
    CHECK (char_length(title) BETWEEN 1 AND 200 AND length(btrim(title)) > 0),
  CONSTRAINT library_dialogue_turns_check
    CHECK (
      CASE
        WHEN jsonb_typeof(turns) = 'array' THEN jsonb_array_length(turns) BETWEEN 1 AND 100
        ELSE false
      END
    )
);

CREATE TABLE IF NOT EXISTS library_idioms (
  resource_id uuid PRIMARY KEY REFERENCES library_resources(id) ON DELETE CASCADE,
  expression varchar(500) NOT NULL,
  meaning text NOT NULL,
  usage_note text,
  CONSTRAINT library_idiom_expression_check
    CHECK (char_length(expression) BETWEEN 1 AND 500 AND length(btrim(expression)) > 0),
  CONSTRAINT library_idiom_meaning_check
    CHECK (char_length(meaning) BETWEEN 1 AND 5000 AND length(btrim(meaning)) > 0),
  CONSTRAINT library_idiom_usage_check
    CHECK (usage_note IS NULL OR (char_length(usage_note) BETWEEN 1 AND 5000 AND length(btrim(usage_note)) > 0))
);

CREATE TABLE IF NOT EXISTS library_slang (
  resource_id uuid PRIMARY KEY REFERENCES library_resources(id) ON DELETE CASCADE,
  expression varchar(500) NOT NULL,
  meaning text NOT NULL,
  register varchar(80),
  usage_note text,
  CONSTRAINT library_slang_expression_check
    CHECK (char_length(expression) BETWEEN 1 AND 500 AND length(btrim(expression)) > 0),
  CONSTRAINT library_slang_meaning_check
    CHECK (char_length(meaning) BETWEEN 1 AND 5000 AND length(btrim(meaning)) > 0),
  CONSTRAINT library_slang_register_check
    CHECK (register IS NULL OR (char_length(register) BETWEEN 1 AND 80 AND length(btrim(register)) > 0)),
  CONSTRAINT library_slang_usage_check
    CHECK (usage_note IS NULL OR (char_length(usage_note) BETWEEN 1 AND 5000 AND length(btrim(usage_note)) > 0))
);

CREATE TABLE IF NOT EXISTS library_cultural_notes (
  resource_id uuid PRIMARY KEY REFERENCES library_resources(id) ON DELETE CASCADE,
  title varchar(200) NOT NULL,
  body text NOT NULL,
  CONSTRAINT library_cultural_note_title_check
    CHECK (char_length(title) BETWEEN 1 AND 200 AND length(btrim(title)) > 0),
  CONSTRAINT library_cultural_note_body_check
    CHECK (char_length(body) BETWEEN 1 AND 20000 AND length(btrim(body)) > 0)
);

CREATE TABLE IF NOT EXISTS library_pronunciations (
  resource_id uuid PRIMARY KEY REFERENCES library_resources(id) ON DELETE CASCADE,
  term varchar(500) NOT NULL,
  phonetic varchar(500) NOT NULL,
  notes text,
  CONSTRAINT library_pronunciation_term_check
    CHECK (char_length(term) BETWEEN 1 AND 500 AND length(btrim(term)) > 0),
  CONSTRAINT library_pronunciation_phonetic_check
    CHECK (char_length(phonetic) BETWEEN 1 AND 500 AND length(btrim(phonetic)) > 0),
  CONSTRAINT library_pronunciation_notes_check
    CHECK (notes IS NULL OR (char_length(notes) BETWEEN 1 AND 5000 AND length(btrim(notes)) > 0))
);

CREATE TABLE IF NOT EXISTS library_learning_collections (
  resource_id uuid PRIMARY KEY REFERENCES library_resources(id) ON DELETE CASCADE,
  title varchar(200) NOT NULL,
  description text NOT NULL,
  CONSTRAINT library_collection_title_check
    CHECK (char_length(title) BETWEEN 1 AND 200 AND length(btrim(title)) > 0),
  CONSTRAINT library_collection_description_check
    CHECK (char_length(description) BETWEEN 1 AND 2000 AND length(btrim(description)) > 0)
);

CREATE TABLE IF NOT EXISTS library_collection_members (
  collection_resource_id uuid NOT NULL REFERENCES library_resources(id) ON DELETE CASCADE,
  member_resource_id uuid NOT NULL REFERENCES library_resources(id) ON DELETE RESTRICT,
  sort_order smallint NOT NULL DEFAULT 0,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_resource_id, member_resource_id),
  CONSTRAINT library_collection_member_distinct_check
    CHECK (collection_resource_id <> member_resource_id),
  CONSTRAINT library_collection_member_order_check
    CHECK (sort_order >= 0)
);

CREATE INDEX IF NOT EXISTS library_collection_members_member_idx
  ON library_collection_members (member_resource_id, collection_resource_id);

CREATE OR REPLACE FUNCTION library_validate_resource_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_type library_resource_type;
  actual_type library_resource_type;
BEGIN
  expected_type := TG_ARGV[0]::library_resource_type;
  SELECT resource_type INTO actual_type
  FROM library_resources
  WHERE id = NEW.resource_id;
  IF actual_type IS NULL OR actual_type <> expected_type THEN
    RAISE EXCEPTION 'LIBRARY_RESOURCE_TYPE_MISMATCH'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION library_validate_collection_member_types()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM library_resources
    WHERE id = NEW.collection_resource_id
      AND resource_type = 'LEARNING_COLLECTION'::library_resource_type
  ) THEN
    RAISE EXCEPTION 'LIBRARY_COLLECTION_TYPE_MISMATCH'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.collection_resource_id = NEW.member_resource_id THEN
    RAISE EXCEPTION 'LIBRARY_COLLECTION_MEMBER_SELF_REFERENCE'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION library_protect_resource_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.resource_type IS DISTINCT FROM OLD.resource_type AND (
    EXISTS (SELECT 1 FROM library_vocabularies WHERE resource_id = NEW.id)
    OR EXISTS (SELECT 1 FROM library_sentences WHERE resource_id = NEW.id)
    OR EXISTS (SELECT 1 FROM library_translations WHERE resource_id = NEW.id)
    OR EXISTS (SELECT 1 FROM library_grammar_items WHERE resource_id = NEW.id)
    OR EXISTS (SELECT 1 FROM library_dialogues WHERE resource_id = NEW.id)
    OR EXISTS (SELECT 1 FROM library_idioms WHERE resource_id = NEW.id)
    OR EXISTS (SELECT 1 FROM library_slang WHERE resource_id = NEW.id)
    OR EXISTS (SELECT 1 FROM library_cultural_notes WHERE resource_id = NEW.id)
    OR EXISTS (SELECT 1 FROM library_pronunciations WHERE resource_id = NEW.id)
    OR EXISTS (SELECT 1 FROM library_learning_collections WHERE resource_id = NEW.id)
  ) THEN
    RAISE EXCEPTION 'LIBRARY_RESOURCE_TYPE_IMMUTABLE'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS library_resources_type_guard
  ON library_resources;

CREATE TRIGGER library_resources_type_guard
  BEFORE UPDATE OF resource_type ON library_resources
  FOR EACH ROW
  EXECUTE FUNCTION library_protect_resource_type();

DROP TRIGGER IF EXISTS library_vocabularies_type_guard
  ON library_vocabularies;

CREATE TRIGGER library_vocabularies_type_guard
  BEFORE INSERT OR UPDATE OF resource_id ON library_vocabularies
  FOR EACH ROW
  EXECUTE FUNCTION library_validate_resource_type('VOCABULARY');

DROP TRIGGER IF EXISTS library_sentences_type_guard
  ON library_sentences;

CREATE TRIGGER library_sentences_type_guard
  BEFORE INSERT OR UPDATE OF resource_id ON library_sentences
  FOR EACH ROW
  EXECUTE FUNCTION library_validate_resource_type('SENTENCE');

DROP TRIGGER IF EXISTS library_translations_type_guard
  ON library_translations;

CREATE TRIGGER library_translations_type_guard
  BEFORE INSERT OR UPDATE OF resource_id ON library_translations
  FOR EACH ROW
  EXECUTE FUNCTION library_validate_resource_type('TRANSLATION');

DROP TRIGGER IF EXISTS library_grammar_items_type_guard
  ON library_grammar_items;

CREATE TRIGGER library_grammar_items_type_guard
  BEFORE INSERT OR UPDATE OF resource_id ON library_grammar_items
  FOR EACH ROW
  EXECUTE FUNCTION library_validate_resource_type('GRAMMAR_ITEM');

DROP TRIGGER IF EXISTS library_dialogues_type_guard
  ON library_dialogues;

CREATE TRIGGER library_dialogues_type_guard
  BEFORE INSERT OR UPDATE OF resource_id ON library_dialogues
  FOR EACH ROW
  EXECUTE FUNCTION library_validate_resource_type('DIALOGUE');

DROP TRIGGER IF EXISTS library_idioms_type_guard
  ON library_idioms;

CREATE TRIGGER library_idioms_type_guard
  BEFORE INSERT OR UPDATE OF resource_id ON library_idioms
  FOR EACH ROW
  EXECUTE FUNCTION library_validate_resource_type('IDIOM');

DROP TRIGGER IF EXISTS library_slang_type_guard
  ON library_slang;

CREATE TRIGGER library_slang_type_guard
  BEFORE INSERT OR UPDATE OF resource_id ON library_slang
  FOR EACH ROW
  EXECUTE FUNCTION library_validate_resource_type('SLANG');

DROP TRIGGER IF EXISTS library_cultural_notes_type_guard
  ON library_cultural_notes;

CREATE TRIGGER library_cultural_notes_type_guard
  BEFORE INSERT OR UPDATE OF resource_id ON library_cultural_notes
  FOR EACH ROW
  EXECUTE FUNCTION library_validate_resource_type('CULTURAL_NOTE');

DROP TRIGGER IF EXISTS library_pronunciations_type_guard
  ON library_pronunciations;

CREATE TRIGGER library_pronunciations_type_guard
  BEFORE INSERT OR UPDATE OF resource_id ON library_pronunciations
  FOR EACH ROW
  EXECUTE FUNCTION library_validate_resource_type('PRONUNCIATION');

DROP TRIGGER IF EXISTS library_learning_collections_type_guard
  ON library_learning_collections;

CREATE TRIGGER library_learning_collections_type_guard
  BEFORE INSERT OR UPDATE OF resource_id ON library_learning_collections
  FOR EACH ROW
  EXECUTE FUNCTION library_validate_resource_type('LEARNING_COLLECTION');

DROP TRIGGER IF EXISTS library_collection_members_type_guard
  ON library_collection_members;

CREATE TRIGGER library_collection_members_type_guard
  BEFORE INSERT OR UPDATE OF collection_resource_id, member_resource_id
  ON library_collection_members
  FOR EACH ROW
  EXECUTE FUNCTION library_validate_collection_member_types();
