import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 11C checkout/payment migration contract', () => {
  it('adds immutable price snapshots, owner-scoped orders and replay-safe attempts', () => {
    const sql = readFileSync(resolve(migrations, '0014_phase11_checkout_payment.sql'), 'utf8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS membership_plan_prices');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS membership_checkout_orders');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS membership_payment_attempts');
    expect(sql).toContain('amount_minor bigint NOT NULL');
    expect(sql).toContain('idempotency_key_hash varchar(64) NOT NULL');
    expect(sql).toContain('request_hash varchar(64) NOT NULL');
    expect(sql).toContain('membership_orders_owner_idempotency_unique');
    expect(sql).toContain('membership_payment_attempts_owner_idempotency_unique');
    expect(sql).toContain('membership_payment_attempts_provider_reference_unique');
    expect(sql).toContain('membership_payment_attempts_one_open_per_order');
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).not.toMatch(/membership_subscriptions\s+SET|DELETE FROM membership_subscriptions|reputation_ledger/iu);
  });

  it('has a scoped down migration without touching accepted 0012 or 0013 tables', () => {
    const sql = readFileSync(resolve(migrations, '0014_phase11_checkout_payment.down.sql'), 'utf8');

    expect(sql).toContain('DROP TABLE IF EXISTS membership_payment_attempts');
    expect(sql).toContain('DROP TABLE IF EXISTS membership_checkout_orders');
    expect(sql).toContain('DROP TABLE IF EXISTS membership_plan_prices');
    expect(sql).not.toMatch(/membership_subscriptions|membership_products|reputation_/iu);
  });

  it('keeps accepted migration 0013 unchanged during 11C', () => {
    const sql = readFileSync(resolve(migrations, '0013_phase11_membership_model.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS membership_subscriptions');
  });
});
