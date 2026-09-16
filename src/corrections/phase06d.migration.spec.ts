import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 06D migration contract', () => {
  it('adds durable contribution evidence and provenance-aware candidate storage', () => {
    const sql = readFileSync(
      resolve(migrations, '0005_phase06_contribution_candidates.sql'),
      'utf8',
    );

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS phase06_contribution_events');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS community_library_candidates');
    expect(sql).toContain('STRUCTURED_RESPONSE_CREATED');
    expect(sql).toContain('RESPONSE_ACCEPTED');
    expect(sql).toContain('ACCEPTANCE_REVOKED');
    expect(sql).toContain('STRUCTURED_RESPONSE_MODERATED');
    expect(sql).toContain('LIBRARY_CANDIDATE_CREATED');
    expect(sql).toContain('UNIQUE (idempotency_key)');
    expect(sql).toContain('community_library_candidates_active_response_idx');
    expect(sql).toContain('PENDING_REVIEW');
    expect(sql).toContain('REFERENCES community_structured_responses(id, parent_post_id)');
    expect(sql).toContain('REFERENCES languages(id) ON DELETE RESTRICT');
  });

  it('has a matching rollback limited to Phase 06D objects', () => {
    const sql = readFileSync(
      resolve(migrations, '0005_phase06_contribution_candidates.down.sql'),
      'utf8',
    );

    expect(sql).toContain('DROP TABLE IF EXISTS phase06_contribution_events');
    expect(sql).toContain('DROP TABLE IF EXISTS community_library_candidates');
    expect(sql).not.toMatch(/DROP TABLE IF EXISTS (users|languages|community_posts)/);
  });
});
