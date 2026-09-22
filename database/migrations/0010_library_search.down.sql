-- Phase 08B1 rollback for 0010_library_search.sql.
-- pg_trgm is intentionally retained because it may be shared by other features.

DROP INDEX IF EXISTS library_learning_collections_search_trgm_idx;
DROP INDEX IF EXISTS library_pronunciations_search_trgm_idx;
DROP INDEX IF EXISTS library_cultural_notes_search_trgm_idx;
DROP INDEX IF EXISTS library_slang_search_trgm_idx;
DROP INDEX IF EXISTS library_idioms_search_trgm_idx;
DROP INDEX IF EXISTS library_dialogues_turns_search_trgm_idx;
DROP INDEX IF EXISTS library_dialogues_title_search_trgm_idx;
DROP INDEX IF EXISTS library_grammar_items_search_trgm_idx;
DROP INDEX IF EXISTS library_translations_search_trgm_idx;
DROP INDEX IF EXISTS library_sentences_search_trgm_idx;
DROP INDEX IF EXISTS library_vocabularies_search_trgm_idx;
DROP INDEX IF EXISTS library_resource_topics_search_trgm_idx;
DROP INDEX IF EXISTS library_resources_public_search_cefr_idx;
DROP INDEX IF EXISTS library_resources_public_search_type_idx;
DROP INDEX IF EXISTS library_resources_public_search_secondary_language_idx;
DROP INDEX IF EXISTS library_resources_public_search_primary_language_idx;
DROP INDEX IF EXISTS library_resources_public_search_updated_idx;
