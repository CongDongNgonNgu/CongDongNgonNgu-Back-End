import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { InMemoryMembershipRepository } from './membership.repository';
import { MembershipAuthorizationService } from './membership.service';
import { InMemoryMembershipFulfillmentRepository } from './membership.fulfillment.repository';
import { MembershipFulfillmentService } from './membership.fulfillment.service';
import { PayOsMembershipWebhookVerifier } from './membership.webhook';
import { InMemoryMembershipPaymentRepository } from './membership.payment.repository';
import type { MembershipPaymentProvider } from './membership.payment-provider';
import { MembershipPaymentService } from './membership.payment.service';
import type { MembershipPlanVersion } from './membership.types';
import type { MembershipPaymentCatalogEntry } from './membership.payment.repository';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PLAN_ID = '33333333-3333-4333-8333-333333333333';
const PRICE_ID = '44444444-4444-4444-8444-444444444444';
const SECRET = 'test-checksum-key';
const NOW = new Date('2026-10-03T12:00:00.000Z');

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

class FakePaymentProvider implements MembershipPaymentProvider {
  readonly code = 'payos';

  isAvailable(): boolean {
    return true;
  }

  getCapabilities() {
    return { available: true, qrAvailable: true, provider: this.code };
  }

  async createCheckout(input: Parameters<MembershipPaymentProvider['createCheckout']>[0]) {
    return {
      providerReference: `fake-payment-link-${input.localAttemptReference}`,
      checkoutUrl: 'https://pay.example/fake-checkout',
    };
  }
}

function signedWebhook(orderId: string, providerReference: string, amount: number) {
  const data = {
    orderCode: orderId,
    amount,
    description: 'CongDongNgonNgu COMMUNITY_MEMBER v1',
    currency: 'VND',
    paymentLinkId: providerReference,
    orderId,
    code: '00',
    transactionDateTime: NOW.toISOString(),
  };
  const canonical = Object.keys(data)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${key}=${data[key as keyof typeof data]}`)
    .join('&');
  return {
    code: '00',
    desc: 'success',
    success: true,
    data,
    signature: createHmac('sha256', SECRET).update(canonical, 'utf8').digest('hex'),
  };
}

describe('fake payment contract lifecycle', () => {
  it('runs order -> fake checkout -> signed webhook -> fulfillment -> exact replay once', async () => {
    const paymentRepository = new InMemoryMembershipPaymentRepository({ catalog: [catalog] });
    const provider = new FakePaymentProvider();
    const paymentService = new MembershipPaymentService(
      paymentRepository,
      provider,
      new MembershipAuthorizationService(new InMemoryMembershipRepository()),
      () => new Date(NOW),
    );
    const { order: orderResponse } = await paymentService.createOrder(USER_ID, 'fake-order-key', {
      planVersionId: PLAN_ID,
      priceId: PRICE_ID,
    });
    const attemptResponse = await paymentService.createPaymentAttempt(USER_ID, orderResponse.id, 'fake-attempt-key');
    expect(attemptResponse).toMatchObject({ status: 'PENDING', checkoutUrl: 'https://pay.example/fake-checkout' });

    const order = await paymentRepository.findOwnedOrder(USER_ID, orderResponse.id);
    const attempt = await paymentRepository.findOwnedAttempt(USER_ID, attemptResponse.id);
    expect(order).not.toBeNull();
    expect(attempt?.providerReference).toBeTruthy();

    const fulfillmentRepository = new InMemoryMembershipFulfillmentRepository({
      orders: [order!],
      attempts: [attempt!],
      plans: [plan],
    });
    const fulfillment = new MembershipFulfillmentService(
      fulfillmentRepository,
      new PayOsMembershipWebhookVerifier(SECRET),
      () => new Date(NOW),
    );
    const payload = signedWebhook(order!.id, attempt!.providerReference!, Number(order!.amountMinor));

    await expect(fulfillment.handleWebhook(payload)).resolves.toMatchObject({
      accepted: true,
      outcome: 'FULFILLED',
    });
    await expect(fulfillment.handleWebhook(payload)).resolves.toMatchObject({
      accepted: true,
      outcome: 'FULFILLED',
    });

    const snapshot = fulfillmentRepository.snapshot();
    expect(snapshot.settlements).toHaveLength(1);
    expect(snapshot.subscriptions).toHaveLength(1);
    expect(snapshot.fulfillments).toMatchObject([{ status: 'FULFILLED' }]);
  });
});
