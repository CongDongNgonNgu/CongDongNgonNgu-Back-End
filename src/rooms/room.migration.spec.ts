import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 13A speaking-room migration contract', () => {
  it('models bounded public/private room facts and ownership', () => {
    const sql = readFileSync(resolve(migrations, '0018_phase13_speaking_rooms.sql'), 'utf8');

    expect(sql).toContain('CREATE TYPE speaking_room_visibility AS ENUM');
    expect(sql).toContain('CREATE TYPE speaking_room_lifecycle AS ENUM');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS speaking_rooms');
    expect(sql).toContain('host_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT');
    expect(sql).toContain('language_id uuid NOT NULL REFERENCES languages(id) ON DELETE RESTRICT');
    expect(sql).toContain('access_token_hash varchar(64)');
    expect(sql).toContain('speaking_rooms_private_access_check');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS speaking_room_moderators');
    expect(sql).not.toMatch(/recording|transcript|provider_secret|api_key/iu);
  });

  it('has a scoped rollback and preserves accepted prior migrations', () => {
    const sql = readFileSync(resolve(migrations, '0018_phase13_speaking_rooms.down.sql'), 'utf8');

    expect(sql).toContain('DROP TABLE IF EXISTS speaking_room_moderators');
    expect(sql).toContain('DROP TABLE IF EXISTS speaking_rooms');
    expect(sql).toContain('DROP TYPE IF EXISTS speaking_room_lifecycle');
    expect(sql).toContain('DROP TYPE IF EXISTS speaking_room_visibility');
    expect(sql).not.toMatch(/DROP TABLE IF EXISTS (users|languages|notifications|membership_|reputation_)/iu);
  });
});
