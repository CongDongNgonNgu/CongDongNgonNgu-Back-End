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
  });

  it('keeps migrations 0001 through 0008 byte-for-byte unchanged', () => {
    for (const [filename, expected] of Object.entries(BASELINE_MIGRATION_SHA256)) {
      const actual = createHash('sha256')
        .update(readFileSync(resolve(migrations, filename)))
        .digest('hex');
      expect(actual).toBe(expected);
    }
  });
});

const BASELINE_MIGRATION_SHA256: Record<string, string> = {
  '0001_identity.sql': '32134ae0fc65645d5214a5f268405ed8233b8bda319ae6a829dba6021b347e31',
  '0001_identity.down.sql': '060654c91e990e4cce717f1dcc7c3f9c0c197f26bb232235a303f865d2431fec',
  '0002_language_profile.sql': '3af338719cbee3923657b467b06f5b78345f641719255e029cbfa1f9959f43ad',
  '0002_language_profile.down.sql': 'f85c2b54263ef41afde9f55414719eaa79bbc4de883723347ffecb89d7a10ea8',
  '0003_community.sql': '3e714dc19c6aef2ada27db3bce576b7af936228e022041bbc52bd59a28838ac7',
  '0003_community.down.sql': '7784401c0036b3e45bd10ac2666091e463c46fd4a23f33db120ee31a5c8570af',
  '0004_corrections_qa.sql': 'f71226f07742c63256c5e82a27614448183b482a969aa6322d472633e01e338b',
  '0004_corrections_qa.down.sql': 'a62d9d1fee182f784819de21992ea48f1b9a897d797e1911eb56c5b278a32f44',
  '0005_phase06_contribution_candidates.sql': '62fbe0651ddfb2fda422a199606a40fd99ad203a505bde6454ce7a020c6b0a14',
  '0005_phase06_contribution_candidates.down.sql': '2082fdbbea5f8147f6a27c3cb94c9d6b511dca384d4971afeeeb2e7989ddc72d',
  '0006_language_exchange_preferences.sql': '4daf9120cebaf98f9ce8aaa546778c05e7ec9f34610af4a475baba9c416fedc2',
  '0006_language_exchange_preferences.down.sql': '3eecefe086f15830c9f31caedd29c39f3f9aabca168e73c78b8d50bce6937fbd',
  '0007_language_exchange_connections.sql': '5688338a078914214d6730bbc30f4d3d380434454b335d086e20a0baec4c5c01',
  '0007_language_exchange_connections.down.sql': 'f83d2e9631a712670596dc185ea0e16e29d07b5ff77de92eb1bf01d6ba9ca995',
  '0008_language_exchange_safety.sql': 'af650e9e86e4b71b9ba416ae46ee4e29834b81665bff71bfd4291bb7aa4b91af',
  '0008_language_exchange_safety.down.sql': 'dbacec18ab739cbc5542acb0cbc568dc3db61ab32c101f1bbfffd2bbda6bdb39',
};
