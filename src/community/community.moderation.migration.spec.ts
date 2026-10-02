import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 15 moderation report migration contract', () => {
  it('adds report workflow metadata and notes without weakening reporter references', () => {
    const sql = readFileSync(resolve(migrations, '0025_phase15_moderation_reports.sql'), 'utf8');

    expect(sql).toContain('ALTER TABLE community_reports');
    expect(sql).toContain('assigned_to_user_id uuid REFERENCES users(id) ON DELETE SET NULL');
    expect(sql).toContain('resolution_reason varchar(1000)');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS community_report_notes');
    expect(sql).toContain('report_id uuid NOT NULL REFERENCES community_reports(id) ON DELETE CASCADE');
    expect(sql).toContain('community_reports_assigned_state_idx');
    expect(sql).not.toMatch(/provider_secret|api_key|payment_signature|raw_payload/iu);
  });

  it('has a scoped rollback that leaves the original community tables intact', () => {
    const sql = readFileSync(resolve(migrations, '0025_phase15_moderation_reports.down.sql'), 'utf8');

    expect(sql).toContain('DROP TABLE IF EXISTS community_report_notes');
    expect(sql).toContain('DROP INDEX IF EXISTS community_reports_assigned_state_idx');
    expect(sql).toContain('DROP COLUMN IF EXISTS resolution_reason');
    expect(sql).toContain('DROP COLUMN IF EXISTS assigned_to_user_id');
    expect(sql).not.toMatch(/DROP TABLE IF EXISTS community_reports/iu);
  });
});
