import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Language exchange migration contract', () => {
  it('adds normalized preference and canonical-selection tables', () => {
    const sql = readFileSync(resolve(migrations, '0006_language_exchange_preferences.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS language_exchange_preferences');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS language_exchange_languages');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS language_exchange_partner_levels');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS language_exchange_goals');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS language_exchange_interests');
    expect(sql).toContain(`CREATE TYPE exchange_language_direction AS ENUM ('OFFER', 'WANT')`);
    expect(sql).toContain(`CREATE TYPE exchange_visibility_mode AS ENUM ('HIDDEN', 'SUMMARY')`);
    expect(sql).toContain(`CREATE TYPE exchange_contact_permission AS ENUM ('NO_CONTACT', 'RELATIONSHIP_GATED')`);
    expect(sql).toContain('DEFAULT false');
    expect(sql).toContain(`CHECK (level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2'))`);
    expect(sql).toContain('REFERENCES user_languages(user_id, id) ON DELETE CASCADE');
    expect(sql).toContain('REFERENCES user_learning_goals(user_id, goal_code) ON DELETE CASCADE');
    expect(sql).toContain('REFERENCES user_profile_interests(user_id, interest_code) ON DELETE CASCADE');
    expect(sql).toContain('language_exchange_discovery_idx');
    expect(sql).toContain('INSERT INTO language_exchange_preferences (user_id)');
  });

  it('has a rollback limited to exchange-owned objects', () => {
    const sql = readFileSync(
      resolve(migrations, '0006_language_exchange_preferences.down.sql'),
      'utf8',
    );
    for (const table of [
      'language_exchange_languages',
      'language_exchange_partner_levels',
      'language_exchange_goals',
      'language_exchange_interests',
      'language_exchange_preferences',
    ]) {
      expect(sql).toContain(`DROP TABLE IF EXISTS ${table}`);
    }
    expect(sql).not.toMatch(/DROP TABLE IF EXISTS (users|languages|user_languages|user_profiles)/);
  });
});
