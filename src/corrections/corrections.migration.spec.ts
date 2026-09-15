import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 06 migration contract', () => {
  it('adds normalized correction, response, acceptance, and vote foundations', () => {
    const sql = readFileSync(resolve(migrations, '0004_corrections_qa.sql'), 'utf8');

    for (const table of [
      'community_correction_requests',
      'community_structured_responses',
      'community_structured_response_acceptances',
      'community_structured_response_votes',
    ]) {
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS ' + table);
    }
    expect(sql).toContain('REFERENCES community_posts(id) ON DELETE RESTRICT');
    expect(sql).toContain('PRIMARY KEY (response_id, user_id)');
    expect(sql).toContain('community_correction_original_immutable');
    expect(sql).toContain('community_structured_responses_parent_idx');
  });

  it('has a matching rollback limited to Phase 06 objects', () => {
    const sql = readFileSync(resolve(migrations, '0004_corrections_qa.down.sql'), 'utf8');

    expect(sql).toContain('DROP TABLE IF EXISTS community_structured_response_votes');
    expect(sql).toContain('DROP TABLE IF EXISTS community_correction_requests');
    expect(sql).not.toMatch(/DROP TABLE IF EXISTS (users|languages|community_posts)/);
  });
});
