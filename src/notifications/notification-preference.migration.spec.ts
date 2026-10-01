import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 12D notification preference migration contract', () => {
  it('stores owner-scoped category/channel overrides with safe enum constraints', () => {
    const sql = readFileSync(resolve(migrations, '0017_phase12_notification_preferences.sql'), 'utf8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS notification_preferences');
    expect(sql).toContain('user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(sql).toContain('PRIMARY KEY (user_id, category, channel)');
    expect(sql).toContain("category IN ('COMMUNITY', 'CORRECTIONS', 'EXCHANGE', 'REPUTATION', 'MEMBERSHIP', 'SECURITY', 'MODERATION', 'SYSTEM')");
    expect(sql).toContain("channel IN ('IN_APP', 'SSE', 'EMAIL', 'PUSH')");
    expect(sql).toContain('notification_preferences_user_updated_idx');
    expect(sql).not.toMatch(/email_api|secret|token|payos|vnpay/iu);
  });

  it('has a scoped rollback and leaves prior notification tables intact', () => {
    const sql = readFileSync(resolve(migrations, '0017_phase12_notification_preferences.down.sql'), 'utf8');

    expect(sql).toContain('DROP TABLE IF EXISTS notification_preferences');
    expect(sql).not.toMatch(/DROP TABLE IF EXISTS (notifications|notification_read_states|users)/iu);
  });
});
