import { describe, expect, it, jest } from '@jest/globals';
import type { Pool } from 'pg';
import { PostgresMembershipPaymentRepository } from './membership.payment.repository';

const PLAN_ID = '33333333-3333-4333-8333-333333333333';
const PRICE_ID = '44444444-4444-4444-8444-444444444444';

describe('PostgresMembershipPaymentRepository', () => {
  it('maps only an active server catalog price and keeps monetary facts as bigint', async () => {
    const query = jest.fn(async (_sql: string) => ({
      rows: [{
        plan_version_id: PLAN_ID,
        product_code: 'COMMUNITY_MEMBER',
        product_status: 'ACTIVE',
        plan_version: 1,
        plan_status: 'ACTIVE',
        plan_display_name: 'Community Member',
        price_id: PRICE_ID,
        price_code: 'MONTHLY',
        price_status: 'ACTIVE',
        amount_minor: '125000',
        currency: 'VND',
        period_unit: 'MONTH',
        period_count: 1,
        available_from: '2026-09-01T00:00:00.000Z',
        available_until: null,
        price_created_at: '2026-09-01T00:00:00.000Z',
      }],
    }));
    const repository = new PostgresMembershipPaymentRepository({ query } as unknown as Pool);

    const result = await repository.findPurchasableCatalogEntry(
      PLAN_ID,
      PRICE_ID,
      new Date('2026-10-01T00:00:00.000Z'),
    );

    expect(result).toMatchObject({
      planVersionId: PLAN_ID,
      productCode: 'COMMUNITY_MEMBER',
      price: {
        id: PRICE_ID,
        amountMinor: 125000n,
        currency: 'VND',
        periodUnit: 'MONTH',
      },
    });
    expect(String(query.mock.calls[0][0])).toContain("mpp.status = 'ACTIVE'::membership_price_status");
    expect(String(query.mock.calls[0][0])).not.toMatch(/secret|webhook|raw_payload/iu);
  });

  it('fails closed for malformed identifiers without querying persistence', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const repository = new PostgresMembershipPaymentRepository({ query } as unknown as Pool);

    await expect(repository.findPurchasableCatalogEntry('not-a-uuid', PRICE_ID, new Date())).resolves.toBeNull();
    await expect(repository.findPurchasableCatalogEntry(PLAN_ID, 'not-a-uuid', new Date())).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('locks the order before selecting an open attempt and never updates a non-created attempt', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM membership_payment_attempts')) {
        return { rows: [] };
      }
      if (sql.includes('UPDATE membership_payment_attempts')) return { rows: [] };
      if (sql.includes('INSERT INTO membership_payment_attempts')) {
        return {
          rows: [{
            id: '66666666-6666-4666-8666-666666666666',
            user_id: '11111111-1111-4111-8111-111111111111',
            order_id: '55555555-5555-4555-8555-555555555555',
            provider_code: 'test-provider',
            local_attempt_reference: 'cdn-mpay-test',
            provider_reference: null,
            checkout_url: null,
            amount_minor: '125000',
            currency: 'VND',
            status: 'CREATED',
            idempotency_key_hash: 'c'.repeat(64),
            request_hash: 'd'.repeat(64),
            expires_at: '2026-10-01T00:15:00.000Z',
            failure_code: null,
            created_at: '2026-10-01T00:00:00.000Z',
            updated_at: '2026-10-01T00:00:00.000Z',
          }],
        };
      }
      if (sql.includes('FROM membership_checkout_orders')) {
        return {
          rows: [{
            id: '55555555-5555-4555-8555-555555555555',
            user_id: '11111111-1111-4111-8111-111111111111',
            plan_version_id: PLAN_ID,
            price_id: PRICE_ID,
            product_code: 'COMMUNITY_MEMBER',
            plan_version: 1,
            plan_display_name: 'Community Member',
            price_code: 'MONTHLY',
            amount_minor: '125000',
            currency: 'VND',
            period_unit: 'MONTH',
            period_count: 1,
            status: 'PENDING_PAYMENT',
            idempotency_key_hash: 'a'.repeat(64),
            request_hash: 'b'.repeat(64),
            created_at: '2026-10-01T00:00:00.000Z',
            updated_at: '2026-10-01T00:00:00.000Z',
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const client = { query, release: jest.fn() };
    const pool = { connect: jest.fn(async () => client) };
    const repository = new PostgresMembershipPaymentRepository(pool as unknown as Pool);

    const result = await repository.createAttempt({
      userId: '11111111-1111-4111-8111-111111111111',
      orderId: '55555555-5555-4555-8555-555555555555',
      providerCode: 'test-provider',
      localAttemptReference: 'cdn-mpay-test',
      idempotencyKeyHash: 'c'.repeat(64),
      requestHash: 'd'.repeat(64),
      expiresAt: new Date('2026-10-01T00:15:00.000Z'),
      now: new Date('2026-10-01T00:00:00.000Z'),
    });

    expect(result?.shouldCallProvider).toBe(true);
    expect(String(query.mock.calls.find(([sql]) => sql.includes('FROM membership_checkout_orders'))?.[0]))
      .toContain('FOR UPDATE');
    expect(String(query.mock.calls.find(([sql]) => sql.includes('UPDATE membership_payment_attempts'))?.[0]))
      .toContain("status = 'EXPIRED'::membership_payment_attempt_status");
  });
});
