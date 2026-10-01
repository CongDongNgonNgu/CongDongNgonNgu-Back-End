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

describe('Phase 13B participant migration contract', () => {
  it('persists bounded participant identity, role, presence and action idempotency', () => {
    const sql = readFileSync(resolve(migrations, '0019_phase13_room_participants.sql'), 'utf8');

    expect(sql).toContain('CREATE TYPE speaking_room_participant_role AS ENUM');
    expect(sql).toContain('CREATE TYPE speaking_room_participant_state AS ENUM');
    expect(sql).toContain('CREATE TYPE speaking_room_participant_action AS ENUM');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS speaking_room_participants');
    expect(sql).toContain('room_id uuid NOT NULL REFERENCES speaking_rooms(id) ON DELETE CASCADE');
    expect(sql).toContain('user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT');
    expect(sql).toContain('join_request_id uuid NOT NULL');
    expect(sql).toContain('speaking_room_participants_active_device_idx');
    expect(sql).toContain('speaking_room_participant_actions');
    expect(sql).toContain('PRIMARY KEY (room_id, user_id, request_id)');
    expect(sql).not.toMatch(/recording|transcript|provider_secret|api_key/iu);
  });

  it('has a scoped rollback for participant state only', () => {
    const sql = readFileSync(resolve(migrations, '0019_phase13_room_participants.down.sql'), 'utf8');

    expect(sql).toContain('DROP TABLE IF EXISTS speaking_room_participant_actions');
    expect(sql).toContain('DROP TABLE IF EXISTS speaking_room_participants');
    expect(sql).toContain('DROP TYPE IF EXISTS speaking_room_participant_action');
    expect(sql).toContain('DROP TYPE IF EXISTS speaking_room_participant_state');
    expect(sql).toContain('DROP TYPE IF EXISTS speaking_room_participant_role');
    expect(sql).not.toMatch(/DROP TABLE IF EXISTS (users|languages|notifications|membership_|reputation_|speaking_rooms)/iu);
  });
});
