import { describe, expect, it } from '@jest/globals';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { InMemoryMembershipRepository } from './membership.repository';
import { MembershipAuthorizationService } from './membership.service';
import {
  InMemoryMembershipPaymentRepository,
  type MembershipPaymentCatalogEntry,
} from './membership.payment.repository';
import {
  MembershipPaymentProviderError,
  type MembershipPaymentProvider,
} from './membership.payment-provider';
import { MembershipPaymentService } from './membership.payment.service';
import type { MembershipEntitlementDefinition, MembershipPlanVersion } from './membership.types';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const PLAN_ID = '33333333-3333-4333-8333-333333333333';
const PRICE_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-01T12:00:00.000Z');

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

const catalog: MembershipPaymentCatalogEntry = {
  planVersionId: PLAN_ID,
  productCode: 'COMMUNITY_MEMBER',
  productStatus: 'ACTIVE',
  planVersion: 1,
  planStatus: 'ACTIVE',
  planDisplayName: plan.displayName,
  price: {
    id: PRICE_ID,
    planVersionId: PLAN_ID,
    code: 'MONTHLY',
    status: 'ACTIVE',
    amountMinor: 125000n,
    currency: 'VND',
    periodUnit: 'MONTH',
    periodCount: 1,
    availableFrom: new Date('2026-09-01T00:00:00.000Z'),
    availableUntil: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  },
};

class TestPaymentProvider implements MembershipPaymentProvider {
  readonly code = 'test-provider';
  calls = 0;
  shouldFail = false;
  amountMinorOverride: bigint | undefined;

  isAvailable(): boolean {
    return true;
  }

  getCapabilities() {
    return { available: true, qrAvailable: true, provider: this.code };
  }

  async createCheckout(input: Parameters<MembershipPaymentProvider['createCheckout']>[0]) {
    this.calls += 1;
    if (this.shouldFail) throw new MembershipPaymentProviderError('UNAVAILABLE', true);
    return {
      providerReference: `provider-${input.localAttemptReference}`,
      checkoutUrl: 'https://pay.example/checkout/test',
      ...(this.amountMinorOverride !== undefined ? { amountMinor: this.amountMinorOverride } : {}),
    };
  }
}

function createService(
  provider: MembershipPaymentProvider = new TestPaymentProvider(),
  paymentRepository = new InMemoryMembershipPaymentRepository({ catalog: [catalog] }),
  membershipRepository = new InMemoryMembershipRepository(),
) {
  return new MembershipPaymentService(
    paymentRepository,
    provider,
    new MembershipAuthorizationService(membershipRepository),
    () => new Date(NOW),
  );
}

describe('MembershipPaymentService', () => {
  it('returns a safe server catalog with Free benefits and plan entitlement benefits', async () => {
    const entitlement: MembershipEntitlementDefinition = {
      id: '77777777-7777-4777-8777-777777777777',
      planVersionId: PLAN_ID,
      featureKey: 'practice.advanced',
      limit: null,
      limitUnit: null,
      parameters: { internalOnly: true },
    };
    const invalidAiEntitlement: MembershipEntitlementDefinition = {
      id: '88888888-8888-4888-8888-888888888888',
      planVersionId: PLAN_ID,
      featureKey: 'ai.practice',
      limit: null,
      limitUnit: null,
      parameters: {},
    };
    const service = createService(
      new TestPaymentProvider(),
      new InMemoryMembershipPaymentRepository({ catalog: [catalog] }),
      new InMemoryMembershipRepository({ plans: [plan], entitlements: [entitlement, invalidAiEntitlement] }),
    );

    const result = await service.getCatalog();

    expect(result.free).toMatchObject({ productCode: 'FREE', displayName: 'Free' });
    expect(result.free.benefits).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'community', label: 'Cộng đồng công khai' }),
    ]));
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({
      planVersionId: PLAN_ID,
      productCode: 'COMMUNITY_MEMBER',
      benefits: [{ code: 'advanced-practice', label: 'Luyện tập nâng cao', detail: null }],
      price: {
        id: PRICE_ID,
        amountMinor: '125000',
        currency: 'VND',
        periodUnit: 'MONTH',
        periodCount: 1,
      },
    });
    expect(result.plans[0].benefits).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ai-practice' }),
    ]));
    expect(result.payment).toEqual({ available: true, qrAvailable: true, provider: 'test-provider' });
    expect(JSON.stringify(result)).not.toMatch(/internalOnly|apiKey|checksum|webhook|userId/iu);
  });

  it('derives amount and plan snapshot from the server catalog, never the client', async () => {
    const service = createService();

    const result = await service.createOrder(USER_ID, 'client-key-001', {
      planVersionId: PLAN_ID,
      priceId: PRICE_ID,
    });

    expect(result.order).toMatchObject({
      product: { code: 'COMMUNITY_MEMBER', planVersion: 1 },
      price: {
        amountMinor: '125000',
        currency: 'VND',
      },
      status: 'PENDING_PAYMENT',
    });
    expect((result.order as unknown as { amountMinor?: unknown }).amountMinor).toBeUndefined();
  });

  it('converges exact checkout replay and rejects conflicting idempotency reuse', async () => {
    const service = createService();
    const first = await service.createOrder(USER_ID, 'client-key-002', { planVersionId: PLAN_ID, priceId: PRICE_ID });
    const replay = await service.createOrder(USER_ID, 'client-key-002', { planVersionId: PLAN_ID, priceId: PRICE_ID });

    expect(replay.order.id).toBe(first.order.id);
    expect(replay.created).toBe(false);
    await expect(service.createOrder(USER_ID, 'client-key-002', {
      planVersionId: '55555555-5555-4555-8555-555555555555',
      priceId: PRICE_ID,
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it('scopes the same client idempotency key to the authenticated owner', async () => {
    const service = createService();
    const first = await service.createOrder(USER_ID, 'client-key-003', { planVersionId: PLAN_ID, priceId: PRICE_ID });
    const second = await service.createOrder(OTHER_USER_ID, 'client-key-003', { planVersionId: PLAN_ID, priceId: PRICE_ID });

    expect(second.order.id).not.toBe(first.order.id);
  });

  it('creates one open payment attempt under double-click and replays it without a second provider call', async () => {
    const provider = new TestPaymentProvider();
    const service = createService(provider);
    const { order } = await service.createOrder(USER_ID, 'client-key-004', { planVersionId: PLAN_ID, priceId: PRICE_ID });

    const attempts = await Promise.all([
      service.createPaymentAttempt(USER_ID, order.id, 'attempt-key-001'),
      service.createPaymentAttempt(USER_ID, order.id, 'attempt-key-001'),
    ]);

    expect(new Set(attempts.map((item) => item.id)).size).toBe(1);
    expect(attempts[0].status).toBe('PENDING');
    expect(provider.calls).toBe(1);
  });

  it('does not create a second attempt for a different key while the first attempt is open', async () => {
    const provider = new TestPaymentProvider();
    const service = createService(provider);
    const { order } = await service.createOrder(USER_ID, 'client-key-005', { planVersionId: PLAN_ID, priceId: PRICE_ID });

    const first = await service.createPaymentAttempt(USER_ID, order.id, 'attempt-key-002');
    const second = await service.createPaymentAttempt(USER_ID, order.id, 'attempt-key-003');

    expect(second.id).toBe(first.id);
    expect(provider.calls).toBe(1);
  });

  it('records a provider failure and permits a new attempt only after the failed attempt is terminal', async () => {
    const provider = new TestPaymentProvider();
    provider.shouldFail = true;
    const service = createService(provider);
    const { order } = await service.createOrder(USER_ID, 'client-key-009', { planVersionId: PLAN_ID, priceId: PRICE_ID });

    await expect(service.createPaymentAttempt(USER_ID, order.id, 'attempt-key-006')).rejects.toMatchObject({
      response: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' },
    });
    provider.shouldFail = false;
    const retry = await service.createPaymentAttempt(USER_ID, order.id, 'attempt-key-007');

    expect(retry.status).toBe('PENDING');
    expect(provider.calls).toBe(2);
    await expect(service.getAttempt(USER_ID, retry.id)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('rejects an amount mismatch returned by the provider adapter without exposing provider details', async () => {
    const provider = new TestPaymentProvider();
    provider.amountMinorOverride = 1n;
    const service = createService(provider);
    const { order } = await service.createOrder(USER_ID, 'client-key-010', { planVersionId: PLAN_ID, priceId: PRICE_ID });

    await expect(service.createPaymentAttempt(USER_ID, order.id, 'attempt-key-008')).rejects.toMatchObject({
      response: { code: 'PAYMENT_PROVIDER_RESPONSE_INVALID' },
    });
    await expect(service.getOrder(USER_ID, order.id)).resolves.toMatchObject({
      attempt: { status: 'FAILED' },
    });
  });

  it('expires an open attempt at the exact server boundary before creating a retry', async () => {
    let now = new Date(NOW);
    const provider = new TestPaymentProvider();
    const service = new MembershipPaymentService(
      new InMemoryMembershipPaymentRepository({ catalog: [catalog] }),
      provider,
      new MembershipAuthorizationService(new InMemoryMembershipRepository()),
      () => new Date(now),
    );
    const { order } = await service.createOrder(USER_ID, 'client-key-011', { planVersionId: PLAN_ID, priceId: PRICE_ID });
    const first = await service.createPaymentAttempt(USER_ID, order.id, 'attempt-key-009');

    now = new Date(NOW.getTime() + 15 * 60 * 1000);
    const retry = await service.createPaymentAttempt(USER_ID, order.id, 'attempt-key-010');

    expect(retry.id).not.toBe(first.id);
    expect(provider.calls).toBe(2);
    await expect(service.getAttempt(USER_ID, first.id)).resolves.toMatchObject({ status: 'EXPIRED' });
  });

  it('keeps order and attempt reads owner-scoped and rejects a key reused for another order', async () => {
    const service = createService();
    const first = await service.createOrder(USER_ID, 'client-key-012', { planVersionId: PLAN_ID, priceId: PRICE_ID });
    const second = await service.createOrder(USER_ID, 'client-key-013', { planVersionId: PLAN_ID, priceId: PRICE_ID });
    const attempt = await service.createPaymentAttempt(USER_ID, first.order.id, 'attempt-key-011');

    await expect(service.getOrder(OTHER_USER_ID, first.order.id)).rejects.toMatchObject({
      response: { code: 'PAYMENT_ORDER_NOT_FOUND' },
    });
    await expect(service.getAttempt(OTHER_USER_ID, attempt.id)).rejects.toMatchObject({
      response: { code: 'PAYMENT_ATTEMPT_NOT_FOUND' },
    });
    await expect(service.createPaymentAttempt(USER_ID, second.order.id, 'attempt-key-011'))
      .rejects.toMatchObject({ response: { code: 'PAYMENT_IDEMPOTENCY_KEY_REUSED' } });
  });

  it('fails safely when the provider is disabled and never grants entitlement', async () => {
    const provider: MembershipPaymentProvider = {
      code: 'disabled',
      isAvailable: () => false,
      getCapabilities: () => ({ available: false, qrAvailable: false, provider: null }),
      createCheckout: async () => {
        throw new MembershipPaymentProviderError('DISABLED', false);
      },
    };
    const service = createService(provider);
    const { order } = await service.createOrder(USER_ID, 'client-key-006', { planVersionId: PLAN_ID, priceId: PRICE_ID });

    await expect(service.createPaymentAttempt(USER_ID, order.id, 'attempt-key-004'))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.getOrder(USER_ID, order.id)).resolves.toMatchObject({
      status: 'PENDING_PAYMENT',
      attempt: { status: 'FAILED' },
    });
  });

  it('rejects a second paid membership purchase while current membership is active', async () => {
    const membership = new InMemoryMembershipRepository({
      plans: [plan],
      subscriptions: [{
        id: '66666666-6666-4666-8666-666666666666',
        userId: USER_ID,
        planVersionId: PLAN_ID,
        status: 'ACTIVE',
        source: 'ADMIN_GRANT',
        startsAt: new Date('2026-09-01T00:00:00.000Z'),
        endsAt: new Date('2026-11-01T00:00:00.000Z'),
        cancelledAt: null,
        revokedAt: null,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      }],
    });
    const service = new MembershipPaymentService(
      new InMemoryMembershipPaymentRepository({ catalog: [catalog] }),
      new TestPaymentProvider(),
      new MembershipAuthorizationService(membership),
      () => new Date(NOW),
    );

    await expect(service.createOrder(USER_ID, 'client-key-007', { planVersionId: PLAN_ID, priceId: PRICE_ID }))
      .rejects.toMatchObject({ response: { code: 'MEMBERSHIP_CHANGE_NOT_SUPPORTED' } });
  });

  it('does not consume contribution credit or create a membership row', async () => {
    const paymentRepository = new InMemoryMembershipPaymentRepository({ catalog: [catalog] });
    const service = new MembershipPaymentService(
      paymentRepository,
      new TestPaymentProvider(),
      new MembershipAuthorizationService(new InMemoryMembershipRepository()),
      () => new Date(NOW),
    );
    const { order } = await service.createOrder(USER_ID, 'client-key-008', { planVersionId: PLAN_ID, priceId: PRICE_ID });
    await service.createPaymentAttempt(USER_ID, order.id, 'attempt-key-005');

    expect(paymentRepository.snapshot().orders).toHaveLength(1);
    expect(paymentRepository.snapshot().attempts).toHaveLength(1);
    expect(paymentRepository.snapshot().subscriptions).toHaveLength(0);
  });
});
