-- Phase 08B1: public library search support.
-- This migration is intentionally frozen for review and MUST NOT be applied by Phase 08B1.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS library_resources_public_search_updated_idx
  ON library_resources (updated_at DESC, id DESC)
  WHERE visibility = 'PUBLIC'::community_post_visibility
    AND moderation_state = 'ACTIVE'::community_moderation_state
    AND review_state = 'VERIFIED'::library_review_state;

CREATE INDEX IF NOT EXISTS library_resources_public_search_primary_language_idx
  ON library_resources (primary_language_id, updated_at DESC, id DESC)
  WHERE visibility = 'PUBLIC'::community_post_visibility
    AND moderation_state = 'ACTIVE'::community_moderation_state
    AND review_state = 'VERIFIED'::library_review_state;

CREATE INDEX IF NOT EXISTS library_resources_public_search_secondary_language_idx
  ON library_resources (secondary_language_id, updated_at DESC, id DESC)
  WHERE visibility = 'PUBLIC'::community_post_visibility
    AND moderation_state = 'ACTIVE'::community_moderation_state
    AND review_state = 'VERIFIED'::library_review_state;

CREATE INDEX IF NOT EXISTS library_resources_public_search_type_idx
  ON library_resources (resource_type, updated_at DESC, id DESC)
  WHERE visibility = 'PUBLIC'::community_post_visibility
    AND moderation_state = 'ACTIVE'::community_moderation_state
    AND review_state = 'VERIFIED'::library_review_state;

CREATE INDEX IF NOT EXISTS library_resources_public_search_cefr_idx
  ON library_resources (cefr_level, updated_at DESC, id DESC)
  WHERE visibility = 'PUBLIC'::community_post_visibility
    AND moderation_state = 'ACTIVE'::community_moderation_state
    AND review_state = 'VERIFIED'::library_review_state;

CREATE INDEX IF NOT EXISTS library_resource_topics_search_trgm_idx
  ON library_resource_topics USING gin (topic gin_trgm_ops);

CREATE INDEX IF NOT EXISTS library_vocabularies_search_trgm_idx
  ON library_vocabularies USING gin (
    term gin_trgm_ops,
    definition gin_trgm_ops,
    part_of_speech gin_trgm_ops,
    example_sentence gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS library_sentences_search_trgm_idx
  ON library_sentences USING gin (
    text_content gin_trgm_ops,
    context gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS library_translations_search_trgm_idx
  ON library_translations USING gin (
    source_text gin_trgm_ops,
    translated_text gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS library_grammar_items_search_trgm_idx
  ON library_grammar_items USING gin (
    title gin_trgm_ops,
    explanation gin_trgm_ops,
    pattern gin_trgm_ops,
    example_text gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS library_dialogues_title_search_trgm_idx
  ON library_dialogues USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS library_dialogues_turns_search_trgm_idx
  ON library_dialogues USING gin ((turns::text) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS library_idioms_search_trgm_idx
  ON library_idioms USING gin (
    expression gin_trgm_ops,
    meaning gin_trgm_ops,
    usage_note gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS library_slang_search_trgm_idx
  ON library_slang USING gin (
    expression gin_trgm_ops,
    meaning gin_trgm_ops,
    register gin_trgm_ops,
    usage_note gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS library_cultural_notes_search_trgm_idx
  ON library_cultural_notes USING gin (
    title gin_trgm_ops,
    body gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS library_pronunciations_search_trgm_idx
  ON library_pronunciations USING gin (
    term gin_trgm_ops,
    phonetic gin_trgm_ops,
    notes gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS library_learning_collections_search_trgm_idx
  ON library_learning_collections USING gin (
    title gin_trgm_ops,
    description gin_trgm_ops
  );
