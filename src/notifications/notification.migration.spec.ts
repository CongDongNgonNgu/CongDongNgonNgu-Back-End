import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 12B notification persistence migration contract', () => {
  it('creates canonical notifications and a separate owner-scoped read state', () => {
    const sql = readFileSync(resolve(migrations, '0016_phase12_notifications_read_state.sql'), 'utf8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS notifications');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS notification_read_states');
    expect(sql).toContain('intent_id varchar(64) NOT NULL');
    expect(sql).toContain('deduplication_key varchar(300) NOT NULL');
    expect(sql).toContain('UNIQUE (deduplication_key)');
    expect(sql).toContain('recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT');
    expect(sql).toContain('FOREIGN KEY (notification_id, recipient_user_id)');
    expect(sql).toContain("status IN ('UNREAD', 'READ')");
    expect(sql).toContain('notification_read_states_owner_status_idx');
    expect(sql).not.toMatch(/email|sms|push|payos|vnpay/iu);
  });

  it('has a scoped rollback and does not remove identity or prior phase tables', () => {
    const sql = readFileSync(resolve(migrations, '0016_phase12_notifications_read_state.down.sql'), 'utf8');

    expect(sql).toContain('DROP TABLE IF EXISTS notification_read_states');
    expect(sql).toContain('DROP TABLE IF EXISTS notifications');
    expect(sql).not.toMatch(/DROP TABLE IF EXISTS (users|membership_|reputation_)/iu);
  });
});
