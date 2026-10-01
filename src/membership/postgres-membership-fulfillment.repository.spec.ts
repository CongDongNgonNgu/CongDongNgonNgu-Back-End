import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('PostgresMembershipFulfillmentRepository transaction contract', () => {
  it('locks the webhook identity chain and separates settlement from retryable fulfillment', () => {
    const source = readFileSync(resolve(__dirname, 'membership.fulfillment.repository.ts'), 'utf8');

    expect(source).toContain('FROM membership_payment_attempts');
    expect(source).toContain('FROM membership_checkout_orders');
    expect(source).toContain('FOR UPDATE');
    expect(source).toContain('WHERE attempt_id = $1::uuid');
    expect(source).toContain("status = 'PAID'::membership_payment_attempt_status");
    expect(source).toContain("status = 'PAID'::membership_order_status");
    expect(source).toContain("'PENDING'");
    expect(source).toContain("'RETRYABLE'");
    expect(source).toContain('pg_advisory_xact_lock');
  });

  it('does not persist raw payloads, secrets or client entitlement claims', () => {
    const source = readFileSync(resolve(__dirname, 'membership.fulfillment.repository.ts'), 'utf8');

    expect(source).not.toMatch(/raw_payload|webhook_secret|api_key/iu);
    expect(source).not.toMatch(/client.*amount|client.*status/iu);
    expect(source).toContain('sanitized_fact');
    expect(source).toContain('membership_subscription_events');
    expect(source).toContain('membership_credit_redemptions');
  });
});
