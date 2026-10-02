import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 15 role policy migration contract', () => {
  it('adds the explicit user, contributor and expert roles without changing existing roles', () => {
    const sql = readFileSync(resolve(migrations, '0024_phase15_role_policy.sql'), 'utf8');

    expect(sql).toContain("ALTER TYPE role_key ADD VALUE IF NOT EXISTS 'USER'");
    expect(sql).toContain("ALTER TYPE role_key ADD VALUE IF NOT EXISTS 'CONTRIBUTOR'");
    expect(sql).toContain("ALTER TYPE role_key ADD VALUE IF NOT EXISTS 'EXPERT'");
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/iu);
  });

  it('does not pretend PostgreSQL enum values can be safely removed on rollback', () => {
    const sql = readFileSync(resolve(migrations, '0024_phase15_role_policy.down.sql'), 'utf8');

    expect(sql).toContain('intentionally a no-op');
    expect(sql).not.toMatch(/DROP TABLE|DROP TYPE|DELETE FROM/iu);
  });
});
