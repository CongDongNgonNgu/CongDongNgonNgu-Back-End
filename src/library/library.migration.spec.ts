import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 08A migration contract', () => {
  it('adds normalized licenses, resources, provenance, type-specific data, and review audit', () => {
    const sql = readFileSync(
      resolve(migrations, '0009_open_language_library.sql'),
      'utf8',
    );

    for (const table of [
      'library_licenses',
      'library_resources',
      'library_resource_topics',
      'library_resource_provenance',
      'library_resource_review_audits',
      'library_collection_members',
      'library_vocabularies',
      'library_sentences',
      'library_translations',
      'library_grammar_items',
      'library_dialogues',
      'library_idioms',
      'library_slang',
      'library_cultural_notes',
      'library_pronunciations',
      'library_learning_collections',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }

    expect(sql).toContain('CREATE TYPE library_resource_type AS ENUM');
    expect(sql).toContain('CREATE TYPE library_review_state AS ENUM');
    expect(sql).toContain('CREATE TYPE library_source_type AS ENUM');
    expect(sql).toContain('CREATE TYPE library_review_action AS ENUM');
    expect(sql).toContain("'REOPEN'");
    expect(sql).toContain('UNIQUE (resource_id, source_type, source_id)');
    expect(sql).toContain('REFERENCES library_licenses(license_key) ON DELETE RESTRICT');
    expect(sql).toContain('REFERENCES community_posts(id) ON DELETE RESTRICT');
    expect(sql).toContain('REFERENCES community_library_candidates(id) ON DELETE RESTRICT');
    expect(sql).toContain('REFERENCES community_structured_response_acceptances(id) ON DELETE RESTRICT');
    expect(sql).toContain('library_validate_provenance_source');
    expect(sql).toContain('provenance_revision bigint NOT NULL DEFAULT 0');
    expect(sql).toContain('CHECK (provenance_revision >= 0)');
    expect(sql).toContain('library_guard_provenance_mutation');
    expect(sql).toContain('library_resource_provenance_mutation_guard');
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('provenance_revision = provenance_revision + 1');
    expect(sql).toContain("parent_state NOT IN");
    expect(sql).toContain('NEW.resource_id IS DISTINCT FROM OLD.resource_id');
    expect(sql).toContain('source_candidate_id');
    expect(sql).toContain('source_acceptance_id');
    expect(sql).toContain('LIBRARY_PHASE06_SOURCE_INVALID');
    expect(sql).toContain('LIBRARY_SOURCE_REFERENCE_INVALID');
    expect(sql).toContain('library_resource_review_audit_reopen_note_check');
    expect(sql).toContain('library_validate_resource_type');
    expect(sql).toContain("'DRAFT'");
    expect(sql).toContain("'COMMUNITY_REVIEW'");
    expect(sql).toContain("'VERIFIED'");
    expect(sql).toContain("'REJECTED'");
    expect(sql).not.toContain('IMPORTED_UNREVIEWED');
  });

  it('has a matching rollback limited to Phase 08A objects', () => {
    const sql = readFileSync(
      resolve(migrations, '0009_open_language_library.down.sql'),
      'utf8',
    );

    for (const table of [
      'library_collection_members',
      'library_resource_topics',
      'library_resource_provenance',
      'library_resource_review_audits',
      'library_learning_collections',
      'library_pronunciations',
      'library_cultural_notes',
      'library_slang',
      'library_idioms',
      'library_dialogues',
      'library_grammar_items',
      'library_translations',
      'library_sentences',
      'library_vocabularies',
      'library_resources',
      'library_licenses',
    ]) {
      expect(sql).toContain(`DROP TABLE IF EXISTS ${table}`);
    }
    expect(sql).not.toMatch(/DROP TABLE IF EXISTS (users|languages|community_posts)/);
    expect(sql).toContain('library_validate_provenance_source');
    expect(sql).toContain('library_resource_provenance_mutation_guard');
    expect(sql).toContain('library_guard_provenance_mutation');
    expect(sql).toContain('DROP FUNCTION IF EXISTS library_guard_provenance_mutation()');
  });

  it('keeps migration checksums canonical and immutable', () => {
    for (const [filename, expected] of Object.entries(BASELINE_MIGRATION_SHA256)) {
      const actual = normalizedMigrationChecksum(
        readFileSync(resolve(migrations, filename), 'utf8'),
      );
      expect(actual).toBe(expected);
    }
  });
});

describe('Phase 08B1 migration contract', () => {
  it('defines only the public-search extension and query-backed indexes', () => {
    const sql = readFileSync(
      resolve(migrations, '0010_library_search.sql'),
      'utf8',
    );
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');

    for (const index of PHASE_08B1_INDEXES) {
      expect(sql).toContain(`CREATE INDEX IF NOT EXISTS ${index}`);
    }
    expect(sql).toContain('USING gin (topic gin_trgm_ops)');
    expect(sql).toContain('USING gin');
    expect(sql).toContain("WHERE visibility = 'PUBLIC'::community_post_visibility");
    expect(sql).toContain("AND moderation_state = 'ACTIVE'::community_moderation_state");
    expect(sql).toContain("AND review_state = 'VERIFIED'::library_review_state");
  });

  it('rolls back every owned index without touching library tables or pg_trgm', () => {
    const sql = readFileSync(
      resolve(migrations, '0010_library_search.down.sql'),
      'utf8',
    );
    for (const index of PHASE_08B1_INDEXES) {
      expect(sql).toContain(`DROP INDEX IF EXISTS ${index}`);
    }
    expect(sql).not.toMatch(/DROP TABLE|DROP EXTENSION/iu);
  });

  it('keeps normalized 0010 migration checksums fixed for review', () => {
    for (const [filename, expected] of Object.entries(PHASE_08B1_MIGRATION_SHA256)) {
      const actual = normalizedMigrationChecksum(
        readFileSync(resolve(migrations, filename), 'utf8'),
      );
      expect(actual).toBe(expected);
    }
  });
});

function normalizedMigrationChecksum(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return createHash('sha256').update(normalized).digest('hex');
}

const BASELINE_MIGRATION_SHA256: Record<string, string> = {
  '0001_identity.sql': '6d568777ff525d4fa168b22337060628144ddd0ae01ed0fdcbda54b94aa4db35',
  '0001_identity.down.sql': '97b36d8f3805850dce1d0a4f7c3c71a72fda23eefd103890f4b907eaa2322b23',
  '0002_language_profile.sql': '20c330b8555b8c004640bf07ee7ceabbd666b41dda574bd74e310c0782e2b1bb',
  '0002_language_profile.down.sql': 'd21c6b854aa60076a1fd1de956bd02f66e6e5d7510881bd7a5f52d4fe1a663fc',
  '0003_community.sql': 'b1c2fdb7f1ad9de92fbea713fd96e21e8c1b07aebb7d36be111804d344f39a51',
  '0003_community.down.sql': '297dc0e79c63e9642a423a40ad9a595acd46c10264702e4c4d4dc88dfaa4bbb9',
  '0004_corrections_qa.sql': 'e7e0f4a24c9e6d6a1b4080a10b4538af3bb9ea4e0372e21bf53623ec047921eb',
  '0004_corrections_qa.down.sql': '59b8d891f6b97bc1134147c15e312d2ad81e98db3123b823686486ba7b92853b',
  '0005_phase06_contribution_candidates.sql': '7abddd57b09ba10c92a0864daa8eceb788626c266e9a554aca5d6e2006ba2730',
  '0005_phase06_contribution_candidates.down.sql': '96535c3aac05b2ecf495d9a520b3346d13b53e99c5b500867b301833cd16313a',
  '0006_language_exchange_preferences.sql': '29bb41a4876ad81c22b0730bc7250998acfda890a41cc26a93bbef06590de656',
  '0006_language_exchange_preferences.down.sql': '8f6229b797f7cee0ed22bff62666e71908b2076c4f9a142dedfa401c71e4bbef',
  '0007_language_exchange_connections.sql': '6b8c48f2c12fd3c0c7e10247077d59d2b351446c45af9b8c6645c4bce5bd53dd',
  '0007_language_exchange_connections.down.sql': 'a64b6cc2dbd8be8284142cca307621c662d50d6e02234e17b1b38f37bf4911bb',
  '0008_language_exchange_safety.sql': 'af650e9e86e4b71b9ba416ae46ee4e29834b81665bff71bfd4291bb7aa4b91af',
  '0008_language_exchange_safety.down.sql': 'dbacec18ab739cbc5542acb0cbc568dc3db61ab32c101f1bbfffd2bbda6bdb39',
  '0009_open_language_library.sql': 'bf178d001a863ac6b1e3ad1c679eef616af699ae5c00646ce26ec779823f9e32',
  '0009_open_language_library.down.sql': 'fec2e5e611effa519430290865f7980f8d52321eab8d7ae0511dfe785281e046',
};

const PHASE_08B1_INDEXES = [
  'library_resources_public_search_updated_idx',
  'library_resources_public_search_primary_language_idx',
  'library_resources_public_search_secondary_language_idx',
  'library_resources_public_search_type_idx',
  'library_resources_public_search_cefr_idx',
  'library_resource_topics_search_trgm_idx',
  'library_vocabularies_search_trgm_idx',
  'library_sentences_search_trgm_idx',
  'library_translations_search_trgm_idx',
  'library_grammar_items_search_trgm_idx',
  'library_dialogues_title_search_trgm_idx',
  'library_dialogues_turns_search_trgm_idx',
  'library_idioms_search_trgm_idx',
  'library_slang_search_trgm_idx',
  'library_cultural_notes_search_trgm_idx',
  'library_pronunciations_search_trgm_idx',
  'library_learning_collections_search_trgm_idx',
] as const;

const PHASE_08B1_MIGRATION_SHA256: Record<string, string> = {
  '0010_library_search.sql': '0f5fc8b6e416fbed8e68eb033c2216ede4a1247d96217b9bf1617ebfe2df83f2',
  '0010_library_search.down.sql': 'dc230f48a075c947584f3e0bdd2aedf2f0a7be20371b4a94ee979c97e54fa0d0',
};
