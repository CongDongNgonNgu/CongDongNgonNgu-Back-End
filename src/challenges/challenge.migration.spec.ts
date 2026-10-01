import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 14A challenge persistence migration contract', () => {
  it('stores finite versioned challenge rules and trusted progress evidence', () => {
    const sql = readFileSync(resolve(migrations, '0021_phase14_challenges.sql'), 'utf8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS challenges');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS challenge_participations');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS challenge_progress_events');
    expect(sql).toContain('eligible_activity_types challenge_activity_type[] NOT NULL');
    expect(sql).toContain('timezone varchar(64) NOT NULL');
    expect(sql).toContain('ends_at > starts_at');
    expect(sql).toContain('UNIQUE (challenge_id, user_id, idempotency_key)');
    expect(sql).toContain('UNIQUE (challenge_id, user_id, activity_type, source_id)');
    expect(sql).toContain('REFERENCES users(id) ON DELETE RESTRICT');
    expect(sql).not.toMatch(/recording|provider_secret|api_key|raw_transcript/iu);
  });

  it('has a scoped rollback that leaves previous phase tables untouched', () => {
    const sql = readFileSync(resolve(migrations, '0021_phase14_challenges.down.sql'), 'utf8');

    expect(sql).toContain('DROP TABLE IF EXISTS challenge_progress_events');
    expect(sql).toContain('DROP TABLE IF EXISTS challenge_participations');
    expect(sql).toContain('DROP TABLE IF EXISTS challenges');
    expect(sql).not.toMatch(/DROP TABLE IF EXISTS (users|languages|speaking_room_|membership_|reputation_)/iu);
  });
});
