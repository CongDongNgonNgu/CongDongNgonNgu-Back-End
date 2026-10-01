import { describe, expect, it } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import {
  InMemoryMembershipFulfillmentRepository,
} from './membership.fulfillment.repository';
import { MembershipFulfillmentService } from './membership.fulfillment.service';
import {
  addMembershipPeriod,
  type VerifiedMembershipWebhook,
} from './membership.fulfillment.types';
import { PayOsMembershipWebhookVerifier } from './membership.webhook';
import type { MembershipCheckoutOrder, MembershipPaymentAttempt } from './membership.payment.types';
import type { MembershipPlanVersion, MembershipSubscription } from './membership.types';

const SECRET = 'test-payos-checksum-key';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const PLAN_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-31T12:00:00.000Z');

const plan: MembershipPlanVersion = {
  id: PLAN_ID,
  productCode: 'COMMUNITY_MEMBER',
  version: 1,
  status: 'ACTIVE',
  displayName: 'Community Member',
  description: 'Membership plan',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  activatedAt: new Date('2026-09-01T00:00:00.000Z'),
  retiredAt: null,
};

function order(userId = USER_ID): MembershipCheckoutOrder {
  return {
    id: ORDER_ID,
    userId,
    planVersionId: PLAN_ID,
    priceId: '66666666-6666-4666-8666-666666666666',
    productCode: 'COMMUNITY_MEMBER',
    planVersion: 1,
    planDisplayName: 'Community Member',
    priceCode: 'MONTHLY',
    amountMinor: 125000n,
    currency: 'VND',
    periodUnit: 'MONTH',
    periodCount: 1,
    status: 'PENDING_PAYMENT',
    idempotencyKeyHash: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    createdAt: new Date('2026-10-31T11:00:00.000Z'),
    updatedAt: new Date('2026-10-31T11:00:00.000Z'),
  };
}

function attempt(userId = USER_ID, status: MembershipPaymentAttempt['status'] = 'PENDING'): MembershipPaymentAttempt {
  return {
    id: ATTEMPT_ID,
    userId,
    orderId: ORDER_ID,
    providerCode: 'payos',
    localAttemptReference: 'cdn-mpay-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    providerReference: 'payment-link-123',
    checkoutUrl: 'https://pay.example/checkout/123',
    amountMinor: 125000n,
    currency: 'VND',
    status,
    idempotencyKeyHash: 'c'.repeat(64),
    requestHash: 'd'.repeat(64),
    expiresAt: new Date('2026-10-31T11:15:00.000Z'),
    failureCode: null,
    createdAt: new Date('2026-10-31T11:00:00.000Z'),
    updatedAt: new Date('2026-10-31T11:00:00.000Z'),
  };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    orderCode: ORDER_ID,
    amount: 125000,
    description: 'cdn-mpay-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    reference: 'bank-transaction-1',
    transactionDateTime: '2026-10-31T12:00:00+07:00',
    currency: 'VND',
    paymentLinkId: 'payment-link-123',
    code: '00',
    desc: 'Thanh toan thanh cong',
  };
  Object.assign(data, overrides);
  const root = {
    code: data.code === '00' ? '00' : '01',
    desc: data.code === '00' ? 'OK' : 'FAILED',
    success: data.code === '00',
    data,
  };
  const canonical = Object.keys(data)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${key}=${data[key] ?? ''}`)
    .join('&');
  return {
    ...root,
    signature: createHmac('sha256', SECRET).update(canonical, 'utf8').digest('hex'),
  };
}

function createService(
  repository: InMemoryMembershipFulfillmentRepository,
  now = NOW,
): MembershipFulfillmentService {
  return new MembershipFulfillmentService(
    repository,
    new PayOsMembershipWebhookVerifier(SECRET),
    () => new Date(now),
  );
}

describe('MembershipFulfillmentService', () => {
  it('verifies, settles and fulfills the exact order/attempt chain once', async () => {
    const repository = new InMemoryMembershipFulfillmentRepository({
      orders: [order()],
      attempts: [attempt()],
      plans: [plan],
    });
    const service = createService(repository);

    await expect(service.handlePayOsWebhook(payload())).resolves.toMatchObject({
      accepted: true,
      outcome: 'FULFILLED',
      retryable: false,
    });
    await expect(service.handlePayOsWebhook(payload())).resolves.toMatchObject({
      accepted: true,
      outcome: 'FULFILLED',
    });

    const snapshot = repository.snapshot();
    expect(snapshot.webhookEvents).toHaveLength(1);
    expect(snapshot.settlements).toHaveLength(1);
    expect(snapshot.fulfillments).toMatchObject([{ status: 'FULFILLED' }]);
    expect(snapshot.subscriptions).toHaveLength(1);
    expect(snapshot.subscriptions[0]).toMatchObject({ source: 'PURCHASE', status: 'ACTIVE' });
    expect(snapshot.subscriptionEvents).toMatchObject([{ eventType: 'ACTIVATED' }]);
  });

  it('rejects altered replay, unknown reference and amount mismatch without granting access', async () => {
    const repository = new InMemoryMembershipFulfillmentRepository({
      orders: [order()],
      attempts: [attempt()],
      plans: [plan],
    });
    const service = createService(repository);

    await expect(service.handlePayOsWebhook(payload({ amount: 125001 }))).resolves.toMatchObject({
      accepted: false,
      outcome: 'REJECTED',
    });
    await expect(service.handlePayOsWebhook(payload({
      paymentLinkId: 'unknown-payment-link',
      description: 'unrelated-payment-description',
    }))).resolves.toMatchObject({
      accepted: false,
      outcome: 'REJECTED',
    });
    expect(repository.snapshot().settlements).toHaveLength(0);
    expect(repository.snapshot().subscriptions).toHaveLength(0);
    expect(repository.snapshot().webhookEvents.map((event) => event.reasonCode)).toEqual([
      'AMOUNT_MISMATCH',
      'UNKNOWN_PAYMENT_REFERENCE',
    ]);

    const collisionRepository = new InMemoryMembershipFulfillmentRepository({
      orders: [order()],
      attempts: [attempt()],
      plans: [plan],
    });
    const collisionService = createService(collisionRepository);
    await collisionService.handlePayOsWebhook(payload());
    await expect(collisionService.handlePayOsWebhook(payload({ amount: 125001 }))).resolves.toMatchObject({
      accepted: false,
      outcome: 'REJECTED',
    });
    expect(collisionRepository.snapshot().webhookEvents[1].reasonCode).toBe('EVENT_COLLISION');
    expect(collisionRepository.snapshot().subscriptions).toHaveLength(1);
  });

  it('fails closed for an invalid signature and never persists a webhook fact', async () => {
    const repository = new InMemoryMembershipFulfillmentRepository({
      orders: [order()],
      attempts: [attempt()],
      plans: [plan],
    });
    const service = createService(repository);
    const invalid = payload();
    invalid.signature = '0'.repeat(64);

    await expect(service.handlePayOsWebhook(invalid)).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.snapshot().webhookEvents).toHaveLength(0);
  });

  it('handles concurrent duplicate delivery with one settlement and one entitlement period', async () => {
    const repository = new InMemoryMembershipFulfillmentRepository({
      orders: [order()],
      attempts: [attempt()],
      plans: [plan],
    });
    const service = createService(repository);

    const results = await Promise.all([
      service.handlePayOsWebhook(payload()),
      service.handlePayOsWebhook(payload()),
      service.handlePayOsWebhook(payload()),
    ]);

    expect(results.every((result) => result.accepted)).toBe(true);
    expect(repository.snapshot().settlements).toHaveLength(1);
    expect(repository.snapshot().subscriptions).toHaveLength(1);
  });

  it('keeps settlement durable when fulfillment retries after a temporary failure', async () => {
    const repository = new InMemoryMembershipFulfillmentRepository({
      orders: [order()],
      attempts: [attempt()],
      plans: [plan],
      failNextFulfillment: true,
    });
    const service = createService(repository);

    await expect(service.handlePayOsWebhook(payload())).resolves.toMatchObject({
      accepted: false,
      outcome: 'FULFILLMENT_RETRYABLE',
      retryable: true,
    });
    expect(repository.snapshot().settlements).toHaveLength(1);
    expect(repository.snapshot().subscriptions).toHaveLength(0);

    await expect(service.handlePayOsWebhook(payload())).resolves.toMatchObject({
      accepted: true,
      outcome: 'FULFILLED',
    });
    expect(repository.snapshot().settlements).toHaveLength(1);
    expect(repository.snapshot().subscriptions).toHaveLength(1);
  });

  it('accepts a delayed success for an expired local attempt but never stacks over an active membership', async () => {
    const existing: MembershipSubscription = {
      id: '77777777-7777-4777-8777-777777777777',
      userId: USER_ID,
      planVersionId: PLAN_ID,
      status: 'ACTIVE',
      source: 'ADMIN_GRANT',
      startsAt: new Date('2026-10-01T00:00:00.000Z'),
      endsAt: new Date('2026-11-30T00:00:00.000Z'),
      cancelledAt: null,
      revokedAt: null,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    };
    const repository = new InMemoryMembershipFulfillmentRepository({
      orders: [order()],
      attempts: [attempt(USER_ID, 'EXPIRED')],
      plans: [plan],
      subscriptions: [existing],
    });
    const service = createService(repository);

    await expect(service.handlePayOsWebhook(payload())).resolves.toMatchObject({
      accepted: false,
      outcome: 'REJECTED',
    });
    const snapshot = repository.snapshot();
    expect(snapshot.settlements).toHaveLength(1);
    expect(snapshot.subscriptions).toHaveLength(1);
    expect(snapshot.fulfillments).toMatchObject([{ status: 'REJECTED', failureCode: 'MEMBERSHIP_ALREADY_ACTIVE' }]);
  });

  it('records a verified provider failure without granting entitlement', async () => {
    const repository = new InMemoryMembershipFulfillmentRepository({
      orders: [order()],
      attempts: [attempt()],
      plans: [plan],
    });
    const service = createService(repository);

    await expect(service.handlePayOsWebhook(payload({ code: '01' }))).resolves.toMatchObject({
      accepted: true,
      outcome: 'PAYMENT_FAILED',
    });
    expect(repository.snapshot().settlements).toHaveLength(0);
    expect(repository.snapshot().subscriptions).toHaveLength(0);
  });

  it('redeems non-monetary credit exactly once and preserves the reputation source', async () => {
    const repository = new InMemoryMembershipFulfillmentRepository({
      plans: [plan],
      reputationPoints: 20,
    });
    const service = createService(repository);

    const first = await service.redeemContributionCredit(USER_ID, 'credit-key-001', {
      planVersionId: PLAN_ID,
      creditUnits: 1,
    });
    const replay = await service.redeemContributionCredit(USER_ID, 'credit-key-001', {
      planVersionId: PLAN_ID,
      creditUnits: 1,
    });

    expect(first).toMatchObject({ created: true, creditUnits: 1, plan: { productCode: 'COMMUNITY_MEMBER' } });
    expect(replay).toMatchObject({ created: false, creditUnits: 1 });
    expect(replay.membership.endsAt).toBe(first.membership.endsAt);
    expect(repository.snapshot().redemptions).toMatchObject([{
      creditUnits: 1,
      consumedReputationPoints: 10,
      contractVersion: 'membership-contribution-credit-v1',
      ruleVersion: 'membership-credit-v1',
    }]);
    expect(repository.snapshot().subscriptionEvents).toMatchObject([{ eventType: 'ACTIVATED' }]);
  });

  it('protects credit from concurrent double spend and rejects insufficient/reversed-derived balance', async () => {
    const repository = new InMemoryMembershipFulfillmentRepository({
      plans: [plan],
      reputationPoints: 10,
    });
    const service = createService(repository);
    const results = await Promise.allSettled([
      service.redeemContributionCredit(USER_ID, 'credit-key-002', { planVersionId: PLAN_ID, creditUnits: 1 }),
      service.redeemContributionCredit(USER_ID, 'credit-key-003', { planVersionId: PLAN_ID, creditUnits: 1 }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const later = new InMemoryMembershipFulfillmentRepository({
      plans: [plan],
      reputationPoints: 10,
    });
    const laterService = createService(later, new Date('2027-01-02T12:00:00.000Z'));
    await laterService.redeemContributionCredit(USER_ID, 'credit-key-004', { planVersionId: PLAN_ID, creditUnits: 1 });
    await expect(laterService.redeemContributionCredit(USER_ID, 'credit-key-005', {
      planVersionId: PLAN_ID,
      creditUnits: 1,
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it('uses explicit half-open calendar periods at month boundaries', () => {
    expect(addMembershipPeriod(new Date('2026-01-31T12:00:00.000Z'), 'MONTH', 1).toISOString())
      .toBe('2026-02-28T12:00:00.000Z');
    expect(addMembershipPeriod(new Date('2026-10-31T12:00:00.000Z'), 'MONTH', 1).toISOString())
      .toBe('2026-11-30T12:00:00.000Z');
  });
});

describe('Membership webhook input contracts', () => {
  it('does not accept payload fields that are outside the bounded provider contract', () => {
    const verifier = new PayOsMembershipWebhookVerifier(SECRET);
    const invalid = payload({});
    (invalid.data as Record<string, unknown>).rawPayload = 'secret';
    expect(() => verifier.verify(invalid)).toThrow('Webhook payload contains unsupported fields');
  });
});

function _typeOnly(_value: VerifiedMembershipWebhook): void {
  return;
}

void OTHER_USER_ID;
