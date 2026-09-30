import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 10A reputation ledger migration contract', () => {
  it('creates a separate append-oriented ledger with replay and reversal guards', () => {
    const sql = readFileSync(resolve(migrations, '0012_phase10_reputation_ledger.sql'), 'utf8');

    expect(sql).toContain("CREATE TYPE reputation_system AS ENUM ('learning_xp', 'community_reputation')");
    expect(sql).toContain('CREATE TYPE reputation_source_type AS ENUM');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS reputation_ledger_entries');
    expect(sql).toContain('user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT');
    expect(sql).toContain('idempotency_key varchar(200) NOT NULL');
    expect(sql).toContain('UNIQUE (idempotency_key)');
    expect(sql).toContain('reversal_of_entry_id uuid REFERENCES reputation_ledger_entries(id) ON DELETE RESTRICT');
    expect(sql).toContain('reputation_ledger_reversal_unique_idx');
    expect(sql).toContain('reputation_ledger_user_balance_idx');
    expect(sql).toContain('delta <> 0');
  });

  it('rolls back only Phase 10A-owned objects', () => {
    const sql = readFileSync(resolve(migrations, '0012_phase10_reputation_ledger.down.sql'), 'utf8');

    expect(sql).toContain('DROP TABLE IF EXISTS reputation_ledger_entries');
    expect(sql).toContain('DROP TYPE IF EXISTS reputation_source_type');
    expect(sql).toContain('DROP TYPE IF EXISTS reputation_system');
    expect(sql).not.toMatch(/DROP TABLE IF EXISTS (users|community_posts|library_resources)/iu);
  });
});
