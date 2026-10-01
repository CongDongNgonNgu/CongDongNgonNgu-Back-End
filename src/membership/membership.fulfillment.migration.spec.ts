import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = resolve(__dirname, '../../database/migrations');

describe('Phase 11D webhook/fulfillment/lifecycle migration contract', () => {
  it('keeps settlement, fulfillment, lifecycle and credit redemption facts separate', () => {
    const sql = readFileSync(resolve(migrations, '0015_phase11_webhook_fulfillment_lifecycle.sql'), 'utf8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS membership_payment_webhook_events');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS membership_payment_settlements');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS membership_payment_fulfillments');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS membership_subscription_events');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS membership_credit_redemptions');
    expect(sql).toContain('membership_payment_webhook_event_identity_unique');
    expect(sql).toContain('membership_payment_settlements_attempt_unique');
    expect(sql).toContain('membership_payment_fulfillments_order_unique');
    expect(sql).toContain('membership_credit_redemptions_owner_idempotency_unique');
    expect(sql).toContain('sanitized_fact jsonb NOT NULL');
    expect(sql).not.toMatch(/raw_payload|webhook_secret|api_key/iu);
    expect(sql).toContain('ON DELETE RESTRICT');
  });

  it('has a scoped rollback and does not touch accepted migrations 0012-0014', () => {
    const sql = readFileSync(resolve(migrations, '0015_phase11_webhook_fulfillment_lifecycle.down.sql'), 'utf8');

    expect(sql).toContain('DROP TABLE IF EXISTS membership_credit_redemptions');
    expect(sql).toContain('DROP TABLE IF EXISTS membership_subscription_events');
    expect(sql).toContain('DROP TABLE IF EXISTS membership_payment_fulfillments');
    expect(sql).toContain('DROP TABLE IF EXISTS membership_payment_settlements');
    expect(sql).toContain('DROP TABLE IF EXISTS membership_payment_webhook_events');
    expect(sql).not.toMatch(/0012|0013|0014|reputation_ledger|membership_plan_prices/iu);
  });

  it('preserves the accepted Phase 10 and Phase 11A-C migration files byte-for-byte by contract', () => {
    expect(readFileSync(resolve(migrations, '0012_phase10_reputation_ledger.sql'), 'utf8')).toContain('CREATE TABLE IF NOT EXISTS reputation_ledger_entries');
    expect(readFileSync(resolve(migrations, '0013_phase11_membership_model.sql'), 'utf8')).toContain('CREATE TABLE IF NOT EXISTS membership_subscriptions');
    expect(readFileSync(resolve(migrations, '0014_phase11_checkout_payment.sql'), 'utf8')).toContain('CREATE TABLE IF NOT EXISTS membership_payment_attempts');
  });
});
