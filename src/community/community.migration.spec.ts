import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Community migration contract', () => {
  it('creates one normalized schema for posts and interactions', () => {
    const sql = readFileSync(resolve(migrations, '0003_community.sql'), 'utf8');

    for (const table of [
      'community_posts',
      'community_comments',
      'community_reactions',
      'community_saved_posts',
      'community_reports',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain('REFERENCES languages(id) ON DELETE RESTRICT');
    expect(sql).toContain('PRIMARY KEY (user_id, post_id, reaction_type)');
    expect(sql).toContain('PRIMARY KEY (user_id, post_id)');
    expect(sql).toContain('community_comments_depth_check');
    expect(sql).toContain('community_comments_parent_depth_check');
    expect(sql).toContain('community_reports_one_target_check');
    expect(sql).toContain('community_posts_feed_idx');
  });

  it('has a matching development rollback without touching identity or language tables', () => {
    const sql = readFileSync(resolve(migrations, '0003_community.down.sql'), 'utf8');

    for (const table of [
      'community_reports',
      'community_saved_posts',
      'community_reactions',
      'community_comments',
      'community_posts',
    ]) {
      expect(sql).toContain(`DROP TABLE IF EXISTS ${table}`);
    }
    expect(sql).not.toMatch(/DROP TABLE IF EXISTS (users|languages)/);
  });
});
