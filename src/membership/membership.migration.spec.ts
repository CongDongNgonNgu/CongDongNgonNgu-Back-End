import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 11A membership model migration contract', () => {
  it('separates products, versioned entitlements and subscription lifecycle facts', () => {
    const sql = readFileSync(resolve(migrations, '0013_phase11_membership_model.sql'), 'utf8');

    expect(sql).toContain("CREATE TYPE membership_product_status AS ENUM ('ACTIVE', 'RETIRED')");
    expect(sql).toContain("CREATE TYPE membership_plan_version_status AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED')");
    expect(sql).toMatch(/CREATE TYPE membership_subscription_status AS ENUM \(\s*'SCHEDULED',\s*'ACTIVE',\s*'EXPIRED',\s*'CANCELLED',\s*'REVOKED'\s*\)/u);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS membership_products');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS membership_plan_versions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS membership_entitlement_definitions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS membership_subscriptions');
    expect(sql).toContain('feature_key varchar(120) NOT NULL');
    expect(sql).toContain('parameters jsonb NOT NULL');
    expect(sql).toContain('product_version_id uuid NOT NULL REFERENCES membership_plan_versions(id) ON DELETE RESTRICT');
    expect(sql).toContain('starts_at timestamptz NOT NULL');
    expect(sql).toContain('ends_at timestamptz');
    expect(sql).toContain('membership_subscriptions_active_user_unique');
    expect(sql).not.toMatch(/payment|payos|webhook|provider/iu);
  });

  it('has a scoped rollback and leaves the Phase 10 ledger untouched', () => {
    const sql = readFileSync(resolve(migrations, '0013_phase11_membership_model.down.sql'), 'utf8');

    expect(sql).toContain('DROP TABLE IF EXISTS membership_subscriptions');
    expect(sql).toContain('DROP TABLE IF EXISTS membership_entitlement_definitions');
    expect(sql).toContain('DROP TABLE IF EXISTS membership_plan_versions');
    expect(sql).toContain('DROP TABLE IF EXISTS membership_products');
    expect(sql).not.toMatch(/DROP TABLE IF EXISTS reputation_ledger_entries/iu);
    expect(sql).not.toMatch(/DROP TYPE IF EXISTS reputation_/iu);
  });
});
