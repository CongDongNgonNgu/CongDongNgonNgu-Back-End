import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 14C event persistence migration contract', () => {
  it('stores bounded timezone-aware event, venue and recurrence facts', () => {
    const sql = readFileSync(
      resolve(migrations, '0022_phase14_events.sql'),
      'utf8',
    );

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS event_recurrence_series');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS community_events');
    expect(sql).toContain('starts_at timestamptz NOT NULL');
    expect(sql).toContain('ends_at timestamptz NOT NULL');
    expect(sql).toContain('timezone varchar(64) NOT NULL');
    expect(sql).toContain(
      'speaking_room_id uuid REFERENCES speaking_rooms(id) ON DELETE RESTRICT',
    );
    expect(sql).toContain('event_recurrence_frequency');
    expect(sql).toContain('event_recurrence_bound_check');
    expect(sql).toContain('community_events_venue_room_check');
    expect(sql).toContain('community_events_cancel_state_check');
    expect(sql).not.toMatch(
      /recording|transcript|provider_secret|api_key|raw_payload/iu,
    );
  });

  it('has a scoped rollback that preserves accepted prior-phase tables', () => {
    const sql = readFileSync(
      resolve(migrations, '0022_phase14_events.down.sql'),
      'utf8',
    );

    expect(sql).toContain('DROP TABLE IF EXISTS community_events');
    expect(sql).toContain('DROP TABLE IF EXISTS event_recurrence_series');
    expect(sql).not.toMatch(
      /DROP TABLE IF EXISTS (users|languages|speaking_rooms|challenges|notifications|membership_|reputation_)/iu,
    );
  });
});
