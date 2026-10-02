import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 15 audit migration contract', () => {
  it('stores append-only actor/action/target evidence without secret columns', () => {
    const sql = readFileSync(resolve(migrations, '0026_phase15_admin_audit.sql'), 'utf8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS admin_audit_log');
    expect(sql).toContain('actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT');
    expect(sql).toContain('action varchar(80) NOT NULL');
    expect(sql).toContain('target_type varchar(80) NOT NULL');
    expect(sql).toContain('reason varchar(1000) NOT NULL');
    expect(sql).toContain('correlation_id varchar(120) NOT NULL');
    expect(sql).toContain('before_state jsonb');
    expect(sql).toContain('after_state jsonb');
    expect(sql).toContain('admin_audit_log_target_idx');
    expect(sql).not.toMatch(/password|token|secret|signature|api_key|raw_payload/iu);
  });

  it('rolls back only the Phase 15 audit table and index', () => {
    const sql = readFileSync(resolve(migrations, '0026_phase15_admin_audit.down.sql'), 'utf8');

    expect(sql).toContain('DROP INDEX IF EXISTS admin_audit_log_target_idx');
    expect(sql).toContain('DROP TABLE IF EXISTS admin_audit_log');
    expect(sql).not.toMatch(/DROP TABLE IF EXISTS (users|community_reports|library_resources)/iu);
  });
});
