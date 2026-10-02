import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 14D event participation persistence migration contract', () => {
  it('stores invitation, registration, reminder and attendance facts with bounded states', () => {
    const sql = readFileSync(
      resolve(migrations, '0023_phase14_event_participation.sql'),
      'utf8',
    );

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS event_invitations');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS event_registrations');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS event_reminder_intents');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS event_attendance');
    expect(sql).toContain('event_registrations_unique_user');
    expect(sql).toContain('event_reminder_intents_unique_kind');
    expect(sql).toContain('event_attendance_marker_check');
    expect(sql).toContain('event_attendance_fingerprint_check');
    expect(sql).toContain("EVENT_REMINDER");
    expect(sql).not.toMatch(/provider_secret|api_key|raw_payload|credit_card/iu);
  });

  it('has a scoped rollback and does not remove prior event or notification tables', () => {
    const sql = readFileSync(
      resolve(migrations, '0023_phase14_event_participation.down.sql'),
      'utf8',
    );

    expect(sql).toContain('DROP TABLE IF EXISTS event_attendance');
    expect(sql).toContain('DROP TABLE IF EXISTS event_reminder_intents');
    expect(sql).toContain('DROP TABLE IF EXISTS event_registrations');
    expect(sql).toContain('DROP TABLE IF EXISTS event_invitations');
    expect(sql).not.toMatch(
      /DROP TABLE IF EXISTS (community_events|event_recurrence_series|notifications|users)/iu,
    );
  });
});
