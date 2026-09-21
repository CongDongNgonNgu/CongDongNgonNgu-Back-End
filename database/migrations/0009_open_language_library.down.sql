DROP TABLE IF EXISTS library_collection_members;
DROP TABLE IF EXISTS library_learning_collections;
DROP TABLE IF EXISTS library_pronunciations;
DROP TABLE IF EXISTS library_cultural_notes;
DROP TABLE IF EXISTS library_slang;
DROP TABLE IF EXISTS library_idioms;
DROP TABLE IF EXISTS library_dialogues;
DROP TABLE IF EXISTS library_grammar_items;
DROP TABLE IF EXISTS library_translations;
DROP TABLE IF EXISTS library_sentences;
DROP TABLE IF EXISTS library_vocabularies;
DROP TABLE IF EXISTS library_resource_review_audits;
DROP TRIGGER IF EXISTS library_resource_provenance_mutation_guard
  ON library_resource_provenance;
DROP TABLE IF EXISTS library_resource_provenance;
DROP TABLE IF EXISTS library_resource_topics;
DROP TABLE IF EXISTS library_resources;
DROP TABLE IF EXISTS library_licenses;

DROP FUNCTION IF EXISTS library_protect_resource_type();
DROP FUNCTION IF EXISTS library_validate_collection_member_types();
DROP FUNCTION IF EXISTS library_guard_provenance_mutation();
DROP FUNCTION IF EXISTS library_validate_provenance_source();
DROP FUNCTION IF EXISTS library_validate_resource_type();

DROP TYPE IF EXISTS library_review_action;
DROP TYPE IF EXISTS library_source_type;
DROP TYPE IF EXISTS library_review_state;
DROP TYPE IF EXISTS library_resource_type;
