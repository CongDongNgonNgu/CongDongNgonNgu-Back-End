import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  cloneCheckoutOrder,
  clonePaymentAttempt,
  isSafeMinorAmount,
  isValidPaymentIdentifier,
  type MembershipCheckoutOrder,
  type MembershipPaymentAttempt,
} from './membership.payment.types';
import {
  cloneMembershipSubscription,
  addMembershipPeriod,
  isBlockingMembershipSubscription,
  MEMBERSHIP_CREDIT_CONTRACT_VERSION,
  MEMBERSHIP_CREDIT_MONTHS_PER_UNIT,
  MEMBERSHIP_CREDIT_POINTS_PER_UNIT,
  MEMBERSHIP_CREDIT_RULE_VERSION,
  MEMBERSHIP_CREDIT_MAX_REDEMPTION_UNITS,
  type MembershipCreditRedemption,
  type MembershipCreditRedemptionResult,
  type MembershipFulfillmentRecord,
  type MembershipFulfillmentSnapshot,
  type MembershipFulfillmentStatus,
  type MembershipSettlement,
  type MembershipSubscriptionEvent,
  type MembershipWebhookEvidence,
  type MembershipWebhookProcessingResult,
  type RedeemMembershipCreditInput,
  type VerifiedMembershipWebhook,
} from './membership.fulfillment.types';
import type {
  MembershipPlanVersion,
  MembershipSubscription,
} from './membership.types';

export const MEMBERSHIP_FULFILLMENT_REPOSITORY = 'MEMBERSHIP_FULFILLMENT_REPOSITORY';

export type MembershipFulfillmentRepositoryErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'CREDIT_INSUFFICIENT'
  | 'MEMBERSHIP_ALREADY_ACTIVE'
  | 'PLAN_UNAVAILABLE'
  | 'REFERENCE_INVALID'
  | 'PERSISTENCE_UNAVAILABLE';

export class MembershipFulfillmentRepositoryError extends Error {
  readonly name = 'MembershipFulfillmentRepositoryError';

  constructor(readonly code: MembershipFulfillmentRepositoryErrorCode, message: string) {
    super(message);
  }
}

export interface MembershipFulfillmentRepository {
  getRedeemedContributionCreditUnits(userId: string): Promise<number>;
  recordVerifiedWebhook(
    input: VerifiedMembershipWebhook,
    now: Date,
  ): Promise<MembershipWebhookProcessingResult>;
  fulfillSettlement(
    settlementId: string,
    now: Date,
  ): Promise<MembershipWebhookProcessingResult>;
  redeemContributionCredit(input: RedeemMembershipCreditInput): Promise<MembershipCreditRedemptionResult>;
}

export interface InMemoryMembershipFulfillmentRepositorySeed {
  orders?: MembershipCheckoutOrder[];
  attempts?: MembershipPaymentAttempt[];
  plans?: MembershipPlanVersion[];
  subscriptions?: MembershipSubscription[];
  reputationPoints?: number;
  failNextFulfillment?: boolean;
}

export class InMemoryMembershipFulfillmentRepository implements MembershipFulfillmentRepository {
  private readonly orders = new Map<string, MembershipCheckoutOrder>();
  private readonly attempts = new Map<string, MembershipPaymentAttempt>();
  private readonly plans = new Map<string, MembershipPlanVersion>();
  private readonly subscriptions = new Map<string, MembershipSubscription>();
  private readonly webhookEvents: MembershipWebhookEvidence[] = [];
  private readonly settlements = new Map<string, MembershipSettlement>();
  private readonly fulfillments = new Map<string, MembershipFulfillmentRecord>();
  private readonly subscriptionEvents: MembershipSubscriptionEvent[] = [];
  private readonly redemptions = new Map<string, MembershipCreditRedemption>();
  private readonly reputationPoints: number;
  private failNextFulfillment: boolean;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(seed: InMemoryMembershipFulfillmentRepositorySeed = {}) {
    for (const order of seed.orders ?? []) this.orders.set(order.id, cloneCheckoutOrder(order));
    for (const attempt of seed.attempts ?? []) this.attempts.set(attempt.id, clonePaymentAttempt(attempt));
    for (const plan of seed.plans ?? []) this.plans.set(plan.id, clonePlan(plan));
    for (const subscription of seed.subscriptions ?? []) {
      this.subscriptions.set(subscription.id, cloneMembershipSubscription(subscription));
    }
    this.reputationPoints = Number.isSafeInteger(seed.reputationPoints) ? Math.max(0, seed.reputationPoints!) : 0;
    this.failNextFulfillment = seed.failNextFulfillment === true;
  }

  async getRedeemedContributionCreditUnits(userId: string): Promise<number> {
    return [...this.redemptions.values()]
      .filter((redemption) => redemption.userId === userId)
      .reduce((total, redemption) => total + redemption.creditUnits, 0);
  }

  recordVerifiedWebhook(
    input: VerifiedMembershipWebhook,
    now: Date,
  ): Promise<MembershipWebhookProcessingResult> {
    return this.withMutation(async () => {
      const exact = this.webhookEvents.find((event) => (
        event.providerCode === input.providerCode &&
        event.eventKey === input.eventKey &&
        event.payloadHash === input.payloadHash
      ));
      if (exact) {
        const settlement = exact.settlementId ? this.settlements.get(exact.settlementId) : undefined;
        return {
          outcome: settlement ? 'REPLAYED' : toProcessingOutcome(exact.outcome),
          reasonCode: exact.reasonCode,
          settlementId: settlement?.id ?? null,
          subscription: settlement ? this.findFulfilledSubscription(settlement.id) : null,
        };
      }

      const evidence: MembershipWebhookEvidence = {
        id: randomUUID(),
        providerCode: input.providerCode,
        eventKey: input.eventKey,
        eventType: input.eventType,
        payloadHash: input.payloadHash,
        outcome: 'RECEIVED',
        reasonCode: null,
        settlementId: null,
        receivedAt: new Date(now),
      };
      this.webhookEvents.push(evidence);

      const collision = this.webhookEvents.find((event) => (
        event.id !== evidence.id &&
        event.providerCode === input.providerCode &&
        event.eventKey === input.eventKey &&
        event.payloadHash !== input.payloadHash
      ));
      if (collision) return this.rejectWebhook(evidence, 'EVENT_COLLISION');

      const attempt = this.findAttemptForWebhook(input);
      if (!attempt) return this.rejectWebhook(evidence, 'UNKNOWN_PAYMENT_REFERENCE');
      const order = this.orders.get(attempt.orderId);
      if (!order) return this.rejectWebhook(evidence, 'UNKNOWN_PAYMENT_ORDER');

      const mismatch = identityMismatch(input, attempt, order);
      if (mismatch) return this.rejectWebhook(evidence, mismatch);

      if (input.eventType === 'PAYMENT_FAILED') {
        if (attempt.status === 'PAID' || order.status === 'PAID') {
          return this.rejectWebhook(evidence, 'OUT_OF_ORDER_PAYMENT_FAILURE');
        }
        if (
          (attempt.status === 'CREATED' || attempt.status === 'PENDING' || attempt.status === 'EXPIRED') &&
          order.status === 'PENDING_PAYMENT'
        ) {
          attempt.status = 'FAILED';
          attempt.failureCode = 'PROVIDER_PAYMENT_FAILED';
          attempt.updatedAt = new Date(now);
          order.status = 'FAILED';
          order.updatedAt = new Date(now);
          evidence.outcome = 'PAYMENT_FAILED';
          return { outcome: 'PAYMENT_FAILED', reasonCode: null, settlementId: null, subscription: null };
        }
        return this.rejectWebhook(evidence, 'PAYMENT_STATE_NOT_SETTLEABLE');
      }

      const existingSettlement = [...this.settlements.values()].find((settlement) => (
        settlement.attemptId === attempt.id || (
          settlement.providerCode === input.providerCode &&
          settlement.providerReference === input.providerReference
        )
      ));
      if (existingSettlement) {
        evidence.outcome = 'REPLAYED';
        evidence.settlementId = existingSettlement.id;
        return {
          outcome: 'REPLAYED',
          reasonCode: 'SETTLEMENT_ALREADY_RECORDED',
          settlementId: existingSettlement.id,
          subscription: this.findFulfilledSubscription(existingSettlement.id),
        };
      }
      if (attempt.status === 'PAID' || order.status === 'PAID') {
        return this.rejectWebhook(evidence, 'PAID_STATE_WITHOUT_SETTLEMENT');
      }
      if (!['CREATED', 'PENDING', 'EXPIRED'].includes(attempt.status)) {
        return this.rejectWebhook(evidence, 'PAYMENT_ATTEMPT_NOT_SETTLEABLE');
      }
      if (order.status !== 'PENDING_PAYMENT') {
        return this.rejectWebhook(evidence, 'PAYMENT_ORDER_NOT_SETTLEABLE');
      }

      const settlement: MembershipSettlement = {
        id: randomUUID(),
        providerCode: input.providerCode,
        eventId: evidence.id,
        orderId: order.id,
        attemptId: attempt.id,
        userId: order.userId,
        providerReference: input.providerReference,
        amountMinor: BigInt(input.amountMinor),
        currency: input.currency,
        settledAt: input.occurredAt ? new Date(input.occurredAt) : new Date(now),
      };
      this.settlements.set(settlement.id, settlement);
      this.fulfillments.set(settlement.id, {
        id: randomUUID(),
        settlementId: settlement.id,
        orderId: order.id,
        userId: order.userId,
        status: 'PENDING',
        subscriptionId: null,
        failureCode: null,
        updatedAt: new Date(now),
      });
      attempt.status = 'PAID';
      attempt.failureCode = null;
      attempt.updatedAt = new Date(now);
      order.status = 'PAID';
      order.updatedAt = new Date(now);
      evidence.outcome = 'SETTLEMENT_RECORDED';
      evidence.settlementId = settlement.id;
      return {
        outcome: 'FULFILLMENT_RETRYABLE',
        reasonCode: 'SETTLEMENT_RECORDED',
        settlementId: settlement.id,
        subscription: null,
      };
    });
  }

  fulfillSettlement(settlementId: string, now: Date): Promise<MembershipWebhookProcessingResult> {
    return this.withMutation(async () => {
      const settlement = this.settlements.get(settlementId);
      const fulfillment = this.fulfillments.get(settlementId);
      if (!settlement || !fulfillment) throw referenceInvalid();
      const existingSubscription = fulfillment.subscriptionId
        ? this.subscriptions.get(fulfillment.subscriptionId)
        : null;
      if (fulfillment.status === 'FULFILLED' && existingSubscription) {
        this.updateWebhookOutcome(settlement, 'FULFILLED', null);
        return {
          outcome: 'FULFILLED',
          reasonCode: null,
          settlementId: settlement.id,
          subscription: cloneMembershipSubscription(existingSubscription),
        };
      }
      if (fulfillment.status === 'REJECTED') {
        this.updateWebhookOutcome(settlement, 'REJECTED', fulfillment.failureCode);
        return { outcome: 'REJECTED', reasonCode: fulfillment.failureCode, settlementId: settlement.id, subscription: null };
      }
      if (this.failNextFulfillment) {
        this.failNextFulfillment = false;
        fulfillment.status = 'RETRYABLE';
        fulfillment.failureCode = 'FULFILLMENT_TEMPORARILY_UNAVAILABLE';
        fulfillment.updatedAt = new Date(now);
        this.updateWebhookOutcome(settlement, 'FULFILLMENT_RETRYABLE', fulfillment.failureCode);
        return {
          outcome: 'FULFILLMENT_RETRYABLE',
          reasonCode: fulfillment.failureCode,
          settlementId: settlement.id,
          subscription: null,
        };
      }

      const order = this.orders.get(settlement.orderId);
      if (!order) throw referenceInvalid();
      const plan = this.plans.get(order.planVersionId);
      if (!plan || plan.status === 'DRAFT') {
        fulfillment.status = 'RETRYABLE';
        fulfillment.failureCode = 'PLAN_UNAVAILABLE';
        fulfillment.updatedAt = new Date(now);
        this.updateWebhookOutcome(settlement, 'FULFILLMENT_RETRYABLE', fulfillment.failureCode);
        return {
          outcome: 'FULFILLMENT_RETRYABLE',
          reasonCode: fulfillment.failureCode,
          settlementId: settlement.id,
          subscription: null,
        };
      }
      this.expireEndedSubscriptions(settlement.userId, now);
      const blocking = [...this.subscriptions.values()].find((subscription) => (
        subscription.userId === settlement.userId && isBlockingMembershipSubscription(subscription, now)
      ));
      if (blocking) {
        fulfillment.status = 'REJECTED';
        fulfillment.failureCode = 'MEMBERSHIP_ALREADY_ACTIVE';
        fulfillment.updatedAt = new Date(now);
        this.updateWebhookOutcome(settlement, 'REJECTED', fulfillment.failureCode);
        return {
          outcome: 'REJECTED',
          reasonCode: fulfillment.failureCode,
          settlementId: settlement.id,
          subscription: null,
        };
      }

      const startsAt = new Date(now);
      const endsAt = addMembershipPeriod(startsAt, order.periodUnit, order.periodCount);
      const subscription: MembershipSubscription = {
        id: randomUUID(),
        userId: settlement.userId,
        planVersionId: order.planVersionId,
        status: 'ACTIVE',
        source: 'PURCHASE',
        startsAt,
        endsAt,
        cancelledAt: null,
        revokedAt: null,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      };
      this.subscriptions.set(subscription.id, subscription);
      this.subscriptionEvents.push({
        id: randomUUID(),
        subscriptionId: subscription.id,
        userId: subscription.userId,
        eventType: 'ACTIVATED',
        sourceId: settlement.id,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        occurredAt: new Date(now),
      });
      fulfillment.status = 'FULFILLED';
      fulfillment.subscriptionId = subscription.id;
      fulfillment.failureCode = null;
      fulfillment.updatedAt = new Date(now);
      this.updateWebhookOutcome(settlement, 'FULFILLED', null);
      return {
        outcome: 'FULFILLED',
        reasonCode: null,
        settlementId: settlement.id,
        subscription: cloneMembershipSubscription(subscription),
      };
    });
  }

  redeemContributionCredit(input: RedeemMembershipCreditInput): Promise<MembershipCreditRedemptionResult> {
    return this.withMutation(async () => {
      const existing = [...this.redemptions.values()].find((redemption) => (
        redemption.userId === input.userId && redemption.idempotencyKeyHash === input.idempotencyKeyHash
      ));
      if (existing) {
        if (existing.requestHash !== input.requestHash) throw idempotencyConflict();
        const subscription = this.subscriptions.get(existing.subscriptionId);
        const plan = this.plans.get(existing.planVersionId);
        if (!subscription || !plan) throw referenceInvalid();
        return {
          created: false,
          redemptionId: existing.id,
          creditUnits: existing.creditUnits,
          plan: clonePlan(plan),
          subscription: cloneMembershipSubscription(subscription),
        };
      }
      const plan = this.plans.get(input.planVersionId);
      if (!plan || plan.status !== 'ACTIVE' || plan.productCode === 'FREE') throw planUnavailable();
      this.expireEndedSubscriptions(input.userId, input.now);
      if ([...this.subscriptions.values()].some((subscription) => (
        subscription.userId === input.userId && isBlockingMembershipSubscription(subscription, input.now)
      ))) throw membershipAlreadyActive();
      const consumed = [...this.redemptions.values()]
        .filter((redemption) => redemption.userId === input.userId)
        .reduce((total, redemption) => total + redemption.creditUnits, 0);
      const available = Math.max(0, Math.floor(this.reputationPoints / MEMBERSHIP_CREDIT_POINTS_PER_UNIT) - consumed);
      if (available < input.creditUnits) throw creditInsufficient();
      const startsAt = new Date(input.now);
      const endsAt = addMembershipPeriod(startsAt, 'MONTH', input.creditUnits * MEMBERSHIP_CREDIT_MONTHS_PER_UNIT);
      const subscription: MembershipSubscription = {
        id: randomUUID(),
        userId: input.userId,
        planVersionId: input.planVersionId,
        status: 'ACTIVE',
        source: 'CONTRIBUTION_CREDIT',
        startsAt,
        endsAt,
        cancelledAt: null,
        revokedAt: null,
        createdAt: new Date(input.now),
        updatedAt: new Date(input.now),
      };
      const redemption: MembershipCreditRedemption = {
        id: randomUUID(),
        userId: input.userId,
        planVersionId: input.planVersionId,
        subscriptionId: subscription.id,
        creditUnits: input.creditUnits,
        consumedReputationPoints: input.creditUnits * MEMBERSHIP_CREDIT_POINTS_PER_UNIT,
        contractVersion: MEMBERSHIP_CREDIT_CONTRACT_VERSION,
        ruleVersion: MEMBERSHIP_CREDIT_RULE_VERSION,
        idempotencyKeyHash: input.idempotencyKeyHash,
        requestHash: input.requestHash,
        createdAt: new Date(input.now),
      };
      this.subscriptions.set(subscription.id, subscription);
      this.redemptions.set(redemption.id, redemption);
      this.subscriptionEvents.push({
        id: randomUUID(),
        subscriptionId: subscription.id,
        userId: subscription.userId,
        eventType: 'ACTIVATED',
        sourceId: redemption.id,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        occurredAt: new Date(input.now),
      });
      return {
        created: true,
        redemptionId: redemption.id,
        creditUnits: redemption.creditUnits,
        plan: clonePlan(plan),
        subscription: cloneMembershipSubscription(subscription),
      };
    });
  }

  snapshot(): MembershipFulfillmentSnapshot {
    return {
      webhookEvents: this.webhookEvents.map(cloneWebhookEvidence),
      settlements: [...this.settlements.values()].map(cloneSettlement),
      fulfillments: [...this.fulfillments.values()].map(cloneFulfillment),
      subscriptions: [...this.subscriptions.values()].map(cloneMembershipSubscription),
      subscriptionEvents: this.subscriptionEvents.map(cloneSubscriptionEvent),
      redemptions: [...this.redemptions.values()].map(cloneRedemption),
    };
  }

  private findAttemptForWebhook(input: VerifiedMembershipWebhook): MembershipPaymentAttempt | null {
    const candidates = [...this.attempts.values()].filter((attempt) => (
      attempt.providerCode === input.providerCode && (
        attempt.providerReference === input.providerReference ||
        (input.localAttemptReference !== null && attempt.localAttemptReference === input.localAttemptReference)
      )
    ));
    return candidates[0] ?? null;
  }

  private rejectWebhook(
    evidence: MembershipWebhookEvidence,
    reasonCode: string,
  ): MembershipWebhookProcessingResult {
    evidence.outcome = 'REJECTED';
    evidence.reasonCode = reasonCode;
    return { outcome: 'REJECTED', reasonCode, settlementId: null, subscription: null };
  }

  private updateWebhookOutcome(
    settlement: MembershipSettlement,
    outcome: string,
    reasonCode: string | null,
  ): void {
    const event = this.webhookEvents.find((candidate) => candidate.id === settlement.eventId);
    if (event) {
      event.outcome = outcome;
      event.reasonCode = reasonCode;
    }
  }

  private findFulfilledSubscription(settlementId: string): MembershipSubscription | null {
    const fulfillment = this.fulfillments.get(settlementId);
    if (!fulfillment?.subscriptionId) return null;
    const subscription = this.subscriptions.get(fulfillment.subscriptionId);
    return subscription ? cloneMembershipSubscription(subscription) : null;
  }

  private expireEndedSubscriptions(userId: string, now: Date): void {
    for (const subscription of this.subscriptions.values()) {
      if (
        subscription.userId === userId &&
        subscription.status === 'ACTIVE' &&
        subscription.endsAt !== null &&
        subscription.endsAt.getTime() <= now.getTime()
      ) {
        subscription.status = 'EXPIRED';
        subscription.updatedAt = new Date(now);
        if (!this.subscriptionEvents.some((event) => (
          event.subscriptionId === subscription.id && event.eventType === 'EXPIRED'
        ))) {
          this.subscriptionEvents.push({
            id: randomUUID(),
            subscriptionId: subscription.id,
            userId: subscription.userId,
            eventType: 'EXPIRED',
            sourceId: subscription.id,
            startsAt: new Date(subscription.startsAt),
            endsAt: subscription.endsAt ? new Date(subscription.endsAt) : null,
            occurredAt: new Date(now),
          });
        }
      }
    }
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class PostgresMembershipFulfillmentRepository implements MembershipFulfillmentRepository {
  constructor(private readonly pool: Pool) {}

  async getRedeemedContributionCreditUnits(userId: string): Promise<number> {
    if (!isValidPaymentIdentifier(userId)) throw referenceInvalid();
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(credit_units), 0)::bigint AS consumed
         FROM membership_credit_redemptions
        WHERE user_id = $1::uuid`,
      [userId],
    );
    const consumed = Number(result.rows[0]?.consumed ?? 0);
    if (!Number.isSafeInteger(consumed) || consumed < 0) throw referenceInvalid();
    return consumed;
  }

  async recordVerifiedWebhook(
    input: VerifiedMembershipWebhook,
    now: Date,
  ): Promise<MembershipWebhookProcessingResult> {
    validateVerifiedWebhook(input, now);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO membership_payment_webhook_events (
           provider_code, event_key, event_type, payload_hash,
           outcome, reason_code, sanitized_fact, received_at
         ) VALUES ($1, $2, $3, $4, 'RECEIVED', NULL, $5::jsonb, $6::timestamptz)
         ON CONFLICT (provider_code, event_key, payload_hash) DO NOTHING
         RETURNING id, provider_code, event_key, event_type, payload_hash,
                   outcome, reason_code, received_at`,
        [input.providerCode, input.eventKey, input.eventType, input.payloadHash, JSON.stringify(input.sanitizedFact), now],
      );
      const event = inserted.rows[0] ?? (await client.query(
        `SELECT id, provider_code, event_key, event_type, payload_hash,
                outcome, reason_code, received_at
           FROM membership_payment_webhook_events
          WHERE provider_code = $1 AND event_key = $2 AND payload_hash = $3
          FOR UPDATE`,
        [input.providerCode, input.eventKey, input.payloadHash],
      )).rows[0];
      if (!event) throw referenceInvalid();

      const existingSettlement = await client.query(
        `SELECT id
           FROM membership_payment_settlements
          WHERE event_id = $1::uuid
          FOR UPDATE`,
        [event.id],
      );
      if (existingSettlement.rows[0]) {
        const subscription = await this.findSettlementSubscription(client, String(existingSettlement.rows[0].id));
        await client.query('COMMIT');
        return {
          outcome: 'REPLAYED',
          reasonCode: String(event.reason_code ?? 'SETTLEMENT_ALREADY_RECORDED'),
          settlementId: String(existingSettlement.rows[0].id),
          subscription,
        };
      }
      if (!inserted.rows[0]) {
        await client.query('COMMIT');
        return {
          outcome: toProcessingOutcome(String(event.outcome)),
          reasonCode: event.reason_code ? String(event.reason_code) : null,
          settlementId: null,
          subscription: null,
        };
      }

      const collision = await client.query(
        `SELECT id
           FROM membership_payment_webhook_events
          WHERE provider_code = $1 AND event_key = $2 AND payload_hash <> $3
          ORDER BY received_at ASC, id ASC
          LIMIT 1
          FOR SHARE`,
        [input.providerCode, input.eventKey, input.payloadHash],
      );
      if (collision.rows[0]) {
        await this.updateWebhookEvent(client, String(event.id), 'REJECTED', 'EVENT_COLLISION');
        await client.query('COMMIT');
        return rejectedResult('EVENT_COLLISION');
      }

      const attemptResult = await client.query(
        `SELECT id, user_id, order_id, provider_code, local_attempt_reference,
                provider_reference, checkout_url, amount_minor, currency, status,
                idempotency_key_hash, request_hash, expires_at, failure_code,
                created_at, updated_at
           FROM membership_payment_attempts
          WHERE provider_code = $1
            AND (provider_reference = $2 OR ($3 IS NOT NULL AND local_attempt_reference = $3))
          ORDER BY created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE`,
        [input.providerCode, input.providerReference, input.localAttemptReference],
      );
      if (!attemptResult.rows[0]) {
        await this.updateWebhookEvent(client, String(event.id), 'REJECTED', 'UNKNOWN_PAYMENT_REFERENCE');
        await client.query('COMMIT');
        return rejectedResult('UNKNOWN_PAYMENT_REFERENCE');
      }
      const attempt = mapAttemptRow(attemptResult.rows[0]);
      const orderResult = await client.query(
        `SELECT id, user_id, plan_version_id, price_id, product_code,
                plan_version, plan_display_name, price_code, amount_minor,
                currency, period_unit, period_count, status,
                idempotency_key_hash, request_hash, created_at, updated_at
           FROM membership_checkout_orders
          WHERE id = $1::uuid
          FOR UPDATE`,
        [attempt.orderId],
      );
      if (!orderResult.rows[0]) {
        await this.updateWebhookEvent(client, String(event.id), 'REJECTED', 'UNKNOWN_PAYMENT_ORDER');
        await client.query('COMMIT');
        return rejectedResult('UNKNOWN_PAYMENT_ORDER');
      }
      const order = mapOrderRow(orderResult.rows[0]);
      const mismatch = identityMismatch(input, attempt, order);
      if (mismatch) {
        await this.updateWebhookEvent(client, String(event.id), 'REJECTED', mismatch);
        await client.query('COMMIT');
        return rejectedResult(mismatch);
      }

      if (input.eventType === 'PAYMENT_FAILED') {
        if (attempt.status === 'PAID' || order.status === 'PAID') {
          await this.updateWebhookEvent(client, String(event.id), 'REJECTED', 'OUT_OF_ORDER_PAYMENT_FAILURE');
          await client.query('COMMIT');
          return rejectedResult('OUT_OF_ORDER_PAYMENT_FAILURE');
        }
        if (
          (attempt.status === 'CREATED' || attempt.status === 'PENDING' || attempt.status === 'EXPIRED') &&
          order.status === 'PENDING_PAYMENT'
        ) {
          await client.query(
            `UPDATE membership_payment_attempts
                SET status = 'FAILED'::membership_payment_attempt_status,
                    failure_code = 'PROVIDER_PAYMENT_FAILED',
                    updated_at = $2::timestamptz
              WHERE id = $1::uuid`,
            [attempt.id, now],
          );
          await client.query(
            `UPDATE membership_checkout_orders
                SET status = 'FAILED'::membership_order_status,
                    updated_at = $2::timestamptz
              WHERE id = $1::uuid AND status = 'PENDING_PAYMENT'::membership_order_status`,
            [order.id, now],
          );
          await this.updateWebhookEvent(client, String(event.id), 'PAYMENT_FAILED', null);
          await client.query('COMMIT');
          return { outcome: 'PAYMENT_FAILED', reasonCode: null, settlementId: null, subscription: null };
        }
        await this.updateWebhookEvent(client, String(event.id), 'REJECTED', 'PAYMENT_STATE_NOT_SETTLEABLE');
        await client.query('COMMIT');
        return rejectedResult('PAYMENT_STATE_NOT_SETTLEABLE');
      }

      const settlementResult = await client.query(
        `SELECT id
           FROM membership_payment_settlements
          WHERE attempt_id = $1::uuid
             OR (provider_code = $2 AND provider_reference = $3)
          LIMIT 1
          FOR UPDATE`,
        [attempt.id, input.providerCode, input.providerReference],
      );
      if (settlementResult.rows[0]) {
        const settlementId = String(settlementResult.rows[0].id);
        const subscription = await this.findSettlementSubscription(client, settlementId);
        await this.updateWebhookEvent(client, String(event.id), 'REPLAYED', 'SETTLEMENT_ALREADY_RECORDED');
        await client.query('COMMIT');
        return {
          outcome: 'REPLAYED',
          reasonCode: 'SETTLEMENT_ALREADY_RECORDED',
          settlementId,
          subscription,
        };
      }
      if (attempt.status === 'PAID' || order.status === 'PAID') {
        await this.updateWebhookEvent(client, String(event.id), 'REJECTED', 'PAID_STATE_WITHOUT_SETTLEMENT');
        await client.query('COMMIT');
        return rejectedResult('PAID_STATE_WITHOUT_SETTLEMENT');
      }
      if (!['CREATED', 'PENDING', 'EXPIRED'].includes(attempt.status)) {
        await this.updateWebhookEvent(client, String(event.id), 'REJECTED', 'PAYMENT_ATTEMPT_NOT_SETTLEABLE');
        await client.query('COMMIT');
        return rejectedResult('PAYMENT_ATTEMPT_NOT_SETTLEABLE');
      }
      if (order.status !== 'PENDING_PAYMENT') {
        await this.updateWebhookEvent(client, String(event.id), 'REJECTED', 'PAYMENT_ORDER_NOT_SETTLEABLE');
        await client.query('COMMIT');
        return rejectedResult('PAYMENT_ORDER_NOT_SETTLEABLE');
      }

      const insertedSettlement = await client.query(
        `INSERT INTO membership_payment_settlements (
           provider_code, event_id, order_id, attempt_id, user_id,
           provider_reference, amount_minor, currency, settled_at, created_at
         ) VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   $6, $7::bigint, $8::membership_payment_currency,
                   $9::timestamptz, $10::timestamptz)
         RETURNING id`,
        [
          input.providerCode,
          event.id,
          order.id,
          attempt.id,
          order.userId,
          input.providerReference,
          input.amountMinor.toString(),
          input.currency,
          input.occurredAt ?? now,
          now,
        ],
      );
      if (!insertedSettlement.rows[0]) throw referenceInvalid();
      const settlementId = String(insertedSettlement.rows[0].id);
      await client.query(
        `UPDATE membership_payment_attempts
            SET status = 'PAID'::membership_payment_attempt_status,
                failure_code = NULL,
                updated_at = $2::timestamptz
          WHERE id = $1::uuid`,
        [attempt.id, now],
      );
      await client.query(
        `UPDATE membership_checkout_orders
            SET status = 'PAID'::membership_order_status,
                updated_at = $2::timestamptz
          WHERE id = $1::uuid`,
        [order.id, now],
      );
      await client.query(
        `INSERT INTO membership_payment_fulfillments (
           settlement_id, order_id, user_id, status, subscription_id,
           failure_code, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING', NULL, NULL, $4, $4)
         ON CONFLICT (settlement_id) DO NOTHING`,
        [settlementId, order.id, order.userId, now],
      );
      await this.updateWebhookEvent(client, String(event.id), 'SETTLEMENT_RECORDED', 'SETTLEMENT_RECORDED');
      await client.query('COMMIT');
      return {
        outcome: 'FULFILLMENT_RETRYABLE',
        reasonCode: 'SETTLEMENT_RECORDED',
        settlementId,
        subscription: null,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresError(error);
    } finally {
      client.release();
    }
  }

  async fulfillSettlement(
    settlementId: string,
    now: Date,
  ): Promise<MembershipWebhookProcessingResult> {
    if (!isValidPaymentIdentifier(settlementId) || !Number.isFinite(now.getTime())) throw referenceInvalid();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const settlementResult = await client.query(
        `SELECT id, provider_code, event_id, order_id, attempt_id, user_id,
                provider_reference, amount_minor, currency, settled_at
           FROM membership_payment_settlements
          WHERE id = $1::uuid
          FOR UPDATE`,
        [settlementId],
      );
      if (!settlementResult.rows[0]) throw referenceInvalid();
      const settlement = mapSettlementRow(settlementResult.rows[0]);
      const fulfillmentResult = await client.query(
        `SELECT id, settlement_id, order_id, user_id, status, subscription_id,
                failure_code, updated_at
           FROM membership_payment_fulfillments
          WHERE settlement_id = $1::uuid
          FOR UPDATE`,
        [settlementId],
      );
      if (!fulfillmentResult.rows[0]) throw referenceInvalid();
      const fulfillment = mapFulfillmentRow(fulfillmentResult.rows[0]);
      if (fulfillment.status === 'FULFILLED' && fulfillment.subscriptionId) {
        const subscription = await this.findSubscription(client, fulfillment.subscriptionId);
        if (!subscription) throw referenceInvalid();
        await this.updateWebhookEvent(client, settlement.eventId, 'FULFILLED', null);
        await client.query('COMMIT');
        return { outcome: 'FULFILLED', reasonCode: null, settlementId, subscription };
      }
      if (fulfillment.status === 'REJECTED') {
        await this.updateWebhookEvent(client, settlement.eventId, 'REJECTED', fulfillment.failureCode);
        await client.query('COMMIT');
        return { outcome: 'REJECTED', reasonCode: fulfillment.failureCode, settlementId, subscription: null };
      }

      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [settlement.userId]);

      const orderResult = await client.query(
        `SELECT id, user_id, plan_version_id, price_id, product_code,
                plan_version, plan_display_name, price_code, amount_minor,
                currency, period_unit, period_count, status,
                idempotency_key_hash, request_hash, created_at, updated_at
           FROM membership_checkout_orders
          WHERE id = $1::uuid
          FOR UPDATE`,
        [settlement.orderId],
      );
      if (!orderResult.rows[0]) throw referenceInvalid();
      const order = mapOrderRow(orderResult.rows[0]);
      const planResult = await client.query(
        `SELECT mpv.id, mp.product_code, mpv.version, mpv.status,
                mpv.display_name, mpv.description, mpv.created_at,
                mpv.activated_at, mpv.retired_at
           FROM membership_plan_versions mpv
           JOIN membership_products mp ON mp.id = mpv.product_id
          WHERE mpv.id = $1::uuid
          FOR SHARE`,
        [order.planVersionId],
      );
      if (!planResult.rows[0] || String(planResult.rows[0].status) === 'DRAFT') {
        await this.updateFulfillment(client, fulfillment.id, 'RETRYABLE', null, 'PLAN_UNAVAILABLE', now);
        await this.updateWebhookEvent(client, settlement.eventId, 'FULFILLMENT_RETRYABLE', 'PLAN_UNAVAILABLE');
        await client.query('COMMIT');
        return { outcome: 'FULFILLMENT_RETRYABLE', reasonCode: 'PLAN_UNAVAILABLE', settlementId, subscription: null };
      }

      const subscriptions = await this.findUserSubscriptionsForUpdate(client, settlement.userId);
      for (const subscription of subscriptions) {
        if (
          subscription.status === 'ACTIVE' &&
          subscription.endsAt !== null &&
          subscription.endsAt.getTime() <= now.getTime()
        ) {
          await this.expireSubscription(client, subscription, now);
        }
      }
      const blocking = subscriptions.find((subscription) => isBlockingMembershipSubscription(subscription, now));
      if (blocking) {
        await this.updateFulfillment(client, fulfillment.id, 'REJECTED', null, 'MEMBERSHIP_ALREADY_ACTIVE', now);
        await this.updateWebhookEvent(client, settlement.eventId, 'REJECTED', 'MEMBERSHIP_ALREADY_ACTIVE');
        await client.query('COMMIT');
        return { outcome: 'REJECTED', reasonCode: 'MEMBERSHIP_ALREADY_ACTIVE', settlementId, subscription: null };
      }

      const startsAt = new Date(now);
      const endsAt = addMembershipPeriod(startsAt, order.periodUnit, order.periodCount);
      const insertedSubscription = await client.query(
        `INSERT INTO membership_subscriptions (
           user_id, product_version_id, status, source,
           starts_at, ends_at, cancelled_at, revoked_at, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, 'ACTIVE'::membership_subscription_status,
                   'PURCHASE'::membership_subscription_source, $3, $4, NULL, NULL, $5, $5)
         RETURNING id, user_id, product_version_id, status, source,
                   starts_at, ends_at, cancelled_at, revoked_at, created_at, updated_at`,
        [settlement.userId, order.planVersionId, startsAt, endsAt, now],
      );
      if (!insertedSubscription.rows[0]) throw referenceInvalid();
      const subscription = mapSubscriptionRow(insertedSubscription.rows[0]);
      await this.insertSubscriptionEvent(client, subscription, 'ACTIVATED', settlement.id, now);
      await this.updateFulfillment(client, fulfillment.id, 'FULFILLED', subscription.id, null, now);
      await this.updateWebhookEvent(client, settlement.eventId, 'FULFILLED', null);
      await client.query('COMMIT');
      return { outcome: 'FULFILLED', reasonCode: null, settlementId, subscription };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresError(error);
    } finally {
      client.release();
    }
  }

  async redeemContributionCredit(input: RedeemMembershipCreditInput): Promise<MembershipCreditRedemptionResult> {
    validateRedemptionInput(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.userId]);
      const existing = await client.query(
        `SELECT r.id, r.user_id, r.plan_version_id, r.subscription_id,
                r.credit_units, r.consumed_reputation_points,
                r.contract_version, r.rule_version, r.idempotency_key_hash,
                r.request_hash, r.created_at,
                mpv.id AS plan_id, mp.product_code, mpv.version AS plan_version,
                mpv.status AS plan_status, mpv.display_name AS plan_display_name,
                mpv.description AS plan_description, mpv.created_at AS plan_created_at,
                mpv.activated_at AS plan_activated_at, mpv.retired_at AS plan_retired_at,
                s.id AS subscription_id_value, s.user_id AS subscription_user_id,
                s.product_version_id AS subscription_plan_id, s.status AS subscription_status,
                s.source AS subscription_source, s.starts_at, s.ends_at,
                s.cancelled_at, s.revoked_at, s.created_at AS subscription_created_at,
                s.updated_at AS subscription_updated_at
           FROM membership_credit_redemptions r
           JOIN membership_plan_versions mpv ON mpv.id = r.plan_version_id
           JOIN membership_products mp ON mp.id = mpv.product_id
           JOIN membership_subscriptions s ON s.id = r.subscription_id
          WHERE r.user_id = $1::uuid AND r.idempotency_key_hash = $2
          FOR UPDATE`,
        [input.userId, input.idempotencyKeyHash],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (String(row.request_hash) !== input.requestHash) throw idempotencyConflict();
        await client.query('COMMIT');
        return {
          created: false,
          redemptionId: String(row.id),
          creditUnits: Number(row.credit_units),
          plan: mapPlanRow(row, 'plan_'),
          subscription: mapSubscriptionRow({
            id: row.subscription_id_value,
            user_id: row.subscription_user_id,
            product_version_id: row.subscription_plan_id,
            status: row.subscription_status,
            source: row.subscription_source,
            starts_at: row.starts_at,
            ends_at: row.ends_at,
            cancelled_at: row.cancelled_at,
            revoked_at: row.revoked_at,
            created_at: row.subscription_created_at,
            updated_at: row.subscription_updated_at,
          }),
        };
      }

      const planResult = await client.query(
        `SELECT mpv.id, mp.product_code, mpv.version, mpv.status,
                mpv.display_name, mpv.description, mpv.created_at,
                mpv.activated_at, mpv.retired_at
           FROM membership_plan_versions mpv
           JOIN membership_products mp ON mp.id = mpv.product_id
          WHERE mpv.id = $1::uuid
            AND mpv.status = 'ACTIVE'::membership_plan_version_status
            AND mp.product_code <> 'FREE'
          FOR SHARE`,
        [input.planVersionId],
      );
      if (!planResult.rows[0]) throw planUnavailable();
      const plan = mapPlanRow(planResult.rows[0]);
      const subscriptions = await this.findUserSubscriptionsForUpdate(client, input.userId);
      for (const subscription of subscriptions) {
        if (
          subscription.status === 'ACTIVE' &&
          subscription.endsAt !== null &&
          subscription.endsAt.getTime() <= input.now.getTime()
        ) {
          await this.expireSubscription(client, subscription, input.now);
        }
      }
      if (subscriptions.some((subscription) => isBlockingMembershipSubscription(subscription, input.now))) {
        throw membershipAlreadyActive();
      }

      const balanceResult = await client.query(
        `SELECT COALESCE(SUM(delta), 0)::bigint AS balance
           FROM reputation_ledger_entries
          WHERE user_id = $1::uuid AND system = 'community_reputation'::reputation_system`,
        [input.userId],
      );
      const balance = Number(balanceResult.rows[0]?.balance ?? 0);
      const consumedResult = await client.query(
        `SELECT COALESCE(SUM(credit_units), 0)::bigint AS consumed
           FROM membership_credit_redemptions
          WHERE user_id = $1::uuid`,
        [input.userId],
      );
      const consumed = Number(consumedResult.rows[0]?.consumed ?? 0);
      const available = Math.max(0, Math.floor(Math.max(0, balance) / MEMBERSHIP_CREDIT_POINTS_PER_UNIT) - consumed);
      if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(consumed) || available < input.creditUnits) {
        throw creditInsufficient();
      }

      const startsAt = new Date(input.now);
      const endsAt = addMembershipPeriod(
        startsAt,
        'MONTH',
        input.creditUnits * MEMBERSHIP_CREDIT_MONTHS_PER_UNIT,
      );
      const insertedSubscription = await client.query(
        `INSERT INTO membership_subscriptions (
           user_id, product_version_id, status, source,
           starts_at, ends_at, cancelled_at, revoked_at, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, 'ACTIVE'::membership_subscription_status,
                   'CONTRIBUTION_CREDIT'::membership_subscription_source, $3, $4, NULL, NULL, $5, $5)
         RETURNING id, user_id, product_version_id, status, source,
                   starts_at, ends_at, cancelled_at, revoked_at, created_at, updated_at`,
        [input.userId, input.planVersionId, startsAt, endsAt, input.now],
      );
      if (!insertedSubscription.rows[0]) throw referenceInvalid();
      const subscription = mapSubscriptionRow(insertedSubscription.rows[0]);
      const insertedRedemption = await client.query(
        `INSERT INTO membership_credit_redemptions (
           user_id, plan_version_id, subscription_id, credit_units,
           consumed_reputation_points, contract_version, rule_version,
           idempotency_key_hash, request_hash, created_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5,
                   $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          input.userId,
          input.planVersionId,
          subscription.id,
          input.creditUnits,
          input.creditUnits * MEMBERSHIP_CREDIT_POINTS_PER_UNIT,
          MEMBERSHIP_CREDIT_CONTRACT_VERSION,
          MEMBERSHIP_CREDIT_RULE_VERSION,
          input.idempotencyKeyHash,
          input.requestHash,
          input.now,
        ],
      );
      if (!insertedRedemption.rows[0]) throw referenceInvalid();
      const redemptionId = String(insertedRedemption.rows[0].id);
      await this.insertSubscriptionEvent(client, subscription, 'ACTIVATED', redemptionId, input.now);
      await client.query('COMMIT');
      return {
        created: true,
        redemptionId,
        creditUnits: input.creditUnits,
        plan,
        subscription,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresError(error);
    } finally {
      client.release();
    }
  }

  private async findSettlementSubscription(client: PoolClient, settlementId: string): Promise<MembershipSubscription | null> {
    const result = await client.query(
      `SELECT s.id, s.user_id, s.product_version_id, s.status, s.source,
              s.starts_at, s.ends_at, s.cancelled_at, s.revoked_at,
              s.created_at, s.updated_at
         FROM membership_payment_fulfillments f
         JOIN membership_subscriptions s ON s.id = f.subscription_id
        WHERE f.settlement_id = $1::uuid`,
      [settlementId],
    );
    return result.rows[0] ? mapSubscriptionRow(result.rows[0]) : null;
  }

  private async findSubscription(client: PoolClient, subscriptionId: string): Promise<MembershipSubscription | null> {
    const result = await client.query(
      `SELECT id, user_id, product_version_id, status, source,
              starts_at, ends_at, cancelled_at, revoked_at, created_at, updated_at
         FROM membership_subscriptions
        WHERE id = $1::uuid`,
      [subscriptionId],
    );
    return result.rows[0] ? mapSubscriptionRow(result.rows[0]) : null;
  }

  private async findUserSubscriptionsForUpdate(client: PoolClient, userId: string): Promise<MembershipSubscription[]> {
    const result = await client.query(
      `SELECT id, user_id, product_version_id, status, source,
              starts_at, ends_at, cancelled_at, revoked_at, created_at, updated_at
         FROM membership_subscriptions
        WHERE user_id = $1::uuid
          AND status IN ('ACTIVE'::membership_subscription_status, 'SCHEDULED'::membership_subscription_status)
        ORDER BY starts_at DESC, updated_at DESC, id DESC
        FOR UPDATE`,
      [userId],
    );
    return result.rows.map(mapSubscriptionRow);
  }

  private async expireSubscription(client: PoolClient, subscription: MembershipSubscription, now: Date): Promise<void> {
    await client.query(
      `UPDATE membership_subscriptions
          SET status = 'EXPIRED'::membership_subscription_status,
              updated_at = $2::timestamptz
        WHERE id = $1::uuid AND status = 'ACTIVE'::membership_subscription_status`,
      [subscription.id, now],
    );
    await this.insertSubscriptionEvent(client, subscription, 'EXPIRED', subscription.id, now);
  }

  private async insertSubscriptionEvent(
    client: PoolClient,
    subscription: MembershipSubscription,
    eventType: 'ACTIVATED' | 'EXPIRED',
    sourceId: string,
    occurredAt: Date,
  ): Promise<void> {
    await client.query(
      `INSERT INTO membership_subscription_events (
         subscription_id, user_id, event_type, source_id,
         starts_at, ends_at, occurred_at, metadata
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, '{}'::jsonb)
       ON CONFLICT (subscription_id, event_type, source_id) DO NOTHING`,
      [subscription.id, subscription.userId, eventType, sourceId, subscription.startsAt, subscription.endsAt, occurredAt],
    );
  }

  private async updateFulfillment(
    client: PoolClient,
    fulfillmentId: string,
    status: MembershipFulfillmentStatus,
    subscriptionId: string | null,
    failureCode: string | null,
    now: Date,
  ): Promise<void> {
    await client.query(
      `UPDATE membership_payment_fulfillments
          SET status = $2, subscription_id = $3::uuid,
              failure_code = $4, updated_at = $5::timestamptz
        WHERE id = $1::uuid`,
      [fulfillmentId, status, subscriptionId, failureCode, now],
    );
  }

  private async updateWebhookEvent(
    client: PoolClient,
    eventId: string,
    outcome: string,
    reasonCode: string | null,
  ): Promise<void> {
    await client.query(
      `UPDATE membership_payment_webhook_events
          SET outcome = $2, reason_code = $3
        WHERE id = $1::uuid`,
      [eventId, outcome, reasonCode],
    );
  }
}

function validateVerifiedWebhook(input: VerifiedMembershipWebhook, now: Date): void {
  if (
    input.providerCode !== 'payos' ||
    !/^[0-9a-f]{64}$/u.test(input.eventKey) ||
    !/^[0-9a-f]{64}$/u.test(input.payloadHash) ||
    input.providerReference.trim().length < 1 ||
    input.providerReference.length > 200 ||
    !isSafeMinorAmount(input.amountMinor) ||
    input.currency !== 'VND' ||
    !Number.isFinite(now.getTime())
  ) throw referenceInvalid();
}

function validateRedemptionInput(input: RedeemMembershipCreditInput): void {
  if (
    !isValidPaymentIdentifier(input.userId) ||
    !isValidPaymentIdentifier(input.planVersionId) ||
    !Number.isSafeInteger(input.creditUnits) ||
    input.creditUnits < 1 ||
    input.creditUnits > MEMBERSHIP_CREDIT_MAX_REDEMPTION_UNITS ||
    !/^[0-9a-f]{64}$/u.test(input.idempotencyKeyHash) ||
    !/^[0-9a-f]{64}$/u.test(input.requestHash) ||
    !Number.isFinite(input.now.getTime())
  ) throw referenceInvalid();
}

function identityMismatch(
  input: VerifiedMembershipWebhook,
  attempt: MembershipPaymentAttempt,
  order: MembershipCheckoutOrder,
): string | null {
  if (attempt.providerCode !== input.providerCode) return 'PROVIDER_IDENTITY_MISMATCH';
  if (attempt.providerReference !== input.providerReference) return 'PROVIDER_REFERENCE_MISMATCH';
  if (input.localAttemptReference !== null && attempt.localAttemptReference !== input.localAttemptReference) {
    return 'ATTEMPT_REFERENCE_MISMATCH';
  }
  if (input.orderReference !== null && order.id !== input.orderReference) return 'ORDER_REFERENCE_MISMATCH';
  if (attempt.userId !== order.userId) return 'OWNER_IDENTITY_MISMATCH';
  if (attempt.orderId !== order.id) return 'ORDER_ATTEMPT_MISMATCH';
  if (attempt.amountMinor !== order.amountMinor || input.amountMinor !== order.amountMinor) {
    return 'AMOUNT_MISMATCH';
  }
  if (attempt.currency !== order.currency || input.currency !== order.currency) return 'CURRENCY_MISMATCH';
  return null;
}

function rejectedResult(reasonCode: string): MembershipWebhookProcessingResult {
  return { outcome: 'REJECTED', reasonCode, settlementId: null, subscription: null };
}

function toProcessingOutcome(value: string): MembershipWebhookProcessingResult['outcome'] {
  if (value === 'PAYMENT_FAILED') return 'PAYMENT_FAILED';
  if (value === 'FULFILLED') return 'FULFILLED';
  if (value === 'REPLAYED') return 'REPLAYED';
  if (value === 'FULFILLMENT_RETRYABLE' || value === 'SETTLEMENT_RECORDED') return 'FULFILLMENT_RETRYABLE';
  return 'REJECTED';
}

function clonePlan(value: MembershipPlanVersion): MembershipPlanVersion {
  return {
    ...value,
    createdAt: new Date(value.createdAt),
    activatedAt: value.activatedAt ? new Date(value.activatedAt) : null,
    retiredAt: value.retiredAt ? new Date(value.retiredAt) : null,
  };
}

function cloneWebhookEvidence(value: MembershipWebhookEvidence): MembershipWebhookEvidence {
  return { ...value, receivedAt: new Date(value.receivedAt) };
}

function cloneSettlement(value: MembershipSettlement): MembershipSettlement {
  return {
    ...value,
    amountMinor: BigInt(value.amountMinor),
    settledAt: new Date(value.settledAt),
  };
}

function cloneFulfillment(value: MembershipFulfillmentRecord): MembershipFulfillmentRecord {
  return { ...value, updatedAt: new Date(value.updatedAt) };
}

function cloneSubscriptionEvent(value: MembershipSubscriptionEvent): MembershipSubscriptionEvent {
  return {
    ...value,
    startsAt: new Date(value.startsAt),
    endsAt: value.endsAt ? new Date(value.endsAt) : null,
    occurredAt: new Date(value.occurredAt),
  };
}

function cloneRedemption(value: MembershipCreditRedemption): MembershipCreditRedemption {
  return { ...value, createdAt: new Date(value.createdAt) };
}

function mapOrderRow(row: Record<string, unknown>): MembershipCheckoutOrder {
  const amountMinor = toSafeMinor(row.amount_minor);
  return {
    id: String(row.id),
    userId: String(row.user_id),
    planVersionId: String(row.plan_version_id),
    priceId: String(row.price_id),
    productCode: String(row.product_code),
    planVersion: Number(row.plan_version),
    planDisplayName: String(row.plan_display_name),
    priceCode: String(row.price_code),
    amountMinor,
    currency: String(row.currency) as MembershipCheckoutOrder['currency'],
    periodUnit: String(row.period_unit) as MembershipCheckoutOrder['periodUnit'],
    periodCount: Number(row.period_count),
    status: String(row.status) as MembershipCheckoutOrder['status'],
    idempotencyKeyHash: String(row.idempotency_key_hash),
    requestHash: String(row.request_hash),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapAttemptRow(row: Record<string, unknown>): MembershipPaymentAttempt {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    orderId: String(row.order_id),
    providerCode: String(row.provider_code),
    localAttemptReference: String(row.local_attempt_reference),
    providerReference: row.provider_reference ? String(row.provider_reference) : null,
    checkoutUrl: row.checkout_url ? String(row.checkout_url) : null,
    amountMinor: toSafeMinor(row.amount_minor),
    currency: String(row.currency) as MembershipPaymentAttempt['currency'],
    status: String(row.status) as MembershipPaymentAttempt['status'],
    idempotencyKeyHash: String(row.idempotency_key_hash),
    requestHash: String(row.request_hash),
    expiresAt: toDate(row.expires_at),
    failureCode: row.failure_code ? String(row.failure_code) : null,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapSettlementRow(row: Record<string, unknown>): MembershipSettlement {
  return {
    id: String(row.id),
    providerCode: String(row.provider_code),
    eventId: String(row.event_id),
    orderId: String(row.order_id),
    attemptId: String(row.attempt_id),
    userId: String(row.user_id),
    providerReference: String(row.provider_reference),
    amountMinor: toSafeMinor(row.amount_minor),
    currency: String(row.currency) as MembershipSettlement['currency'],
    settledAt: toDate(row.settled_at),
  };
}

function mapFulfillmentRow(row: Record<string, unknown>): MembershipFulfillmentRecord {
  return {
    id: String(row.id),
    settlementId: String(row.settlement_id),
    orderId: String(row.order_id),
    userId: String(row.user_id),
    status: String(row.status) as MembershipFulfillmentStatus,
    subscriptionId: row.subscription_id ? String(row.subscription_id) : null,
    failureCode: row.failure_code ? String(row.failure_code) : null,
    updatedAt: toDate(row.updated_at),
  };
}

function mapSubscriptionRow(row: Record<string, unknown>): MembershipSubscription {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    planVersionId: String(row.product_version_id),
    status: String(row.status) as MembershipSubscription['status'],
    source: String(row.source) as MembershipSubscription['source'],
    startsAt: toDate(row.starts_at),
    endsAt: row.ends_at ? toDate(row.ends_at) : null,
    cancelledAt: row.cancelled_at ? toDate(row.cancelled_at) : null,
    revokedAt: row.revoked_at ? toDate(row.revoked_at) : null,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapPlanRow(row: Record<string, unknown>, prefix = ''): MembershipPlanVersion {
  const value = (name: string): unknown => row[`${prefix}${name}`] ?? row[name];
  return {
    id: String(value('id')),
    productCode: String(value('product_code')),
    version: Number(value('version')),
    status: String(value('status')) as MembershipPlanVersion['status'],
    displayName: String(value('display_name')),
    description: String(value('description')),
    createdAt: toDate(value('created_at')),
    activatedAt: value('activated_at') ? toDate(value('activated_at')) : null,
    retiredAt: value('retired_at') ? toDate(value('retired_at')) : null,
  };
}

function toSafeMinor(value: unknown): bigint {
  try {
    const amount = typeof value === 'bigint' ? value : BigInt(String(value));
    if (!isSafeMinorAmount(amount)) throw new Error();
    return amount;
  } catch {
    throw referenceInvalid();
  }
}

function toDate(value: unknown): Date {
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw referenceInvalid();
  return date;
}

function idempotencyConflict(): MembershipFulfillmentRepositoryError {
  return new MembershipFulfillmentRepositoryError(
    'IDEMPOTENCY_CONFLICT',
    'Membership redemption idempotency key was reused with different facts',
  );
}

function creditInsufficient(): MembershipFulfillmentRepositoryError {
  return new MembershipFulfillmentRepositoryError(
    'CREDIT_INSUFFICIENT',
    'Contribution membership credit is insufficient',
  );
}

function membershipAlreadyActive(): MembershipFulfillmentRepositoryError {
  return new MembershipFulfillmentRepositoryError(
    'MEMBERSHIP_ALREADY_ACTIVE',
    'Membership is already active',
  );
}

function planUnavailable(): MembershipFulfillmentRepositoryError {
  return new MembershipFulfillmentRepositoryError(
    'PLAN_UNAVAILABLE',
    'Membership plan is unavailable for this operation',
  );
}

function referenceInvalid(): MembershipFulfillmentRepositoryError {
  return new MembershipFulfillmentRepositoryError(
    'REFERENCE_INVALID',
    'Membership fulfillment persistence reference is invalid',
  );
}

function mapPostgresError(error: unknown): Error {
  if (error instanceof MembershipFulfillmentRepositoryError) return error;
  if (isPostgresError(error)) {
    if (error.code === '23505' && error.constraint?.includes('idempotency')) return idempotencyConflict();
    if (error.code === '23505' || error.code === '23514' || error.code === '22P02' || error.code === '23503') {
      return referenceInvalid();
    }
  }
  return error instanceof Error
    ? error
    : new MembershipFulfillmentRepositoryError('PERSISTENCE_UNAVAILABLE', 'Membership fulfillment persistence failed');
}

function isPostgresError(error: unknown): error is { code: string; constraint?: string } {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string';
}
