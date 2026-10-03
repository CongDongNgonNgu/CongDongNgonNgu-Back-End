import type {
  MembershipPlanVersion,
  MembershipSubscription,
} from './membership.types';
import type {
  MembershipCheckoutOrder,
  MembershipPaymentAttempt,
  MembershipPaymentCurrency,
  MembershipPricePeriodUnit,
} from './membership.payment.types';

export const PAYOS_PROVIDER_CODE = 'payos' as const;

export const MEMBERSHIP_WEBHOOK_EVENT_TYPES = [
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
] as const;
export type MembershipWebhookEventType = typeof MEMBERSHIP_WEBHOOK_EVENT_TYPES[number];

export const MEMBERSHIP_FULFILLMENT_OUTCOMES = [
  'FULFILLED',
  'REPLAYED',
  'REJECTED',
  'FULFILLMENT_RETRYABLE',
  'PAYMENT_FAILED',
] as const;
export type MembershipFulfillmentOutcome = typeof MEMBERSHIP_FULFILLMENT_OUTCOMES[number];

export interface VerifiedMembershipWebhook {
  providerCode: string;
  eventKey: string;
  eventType: MembershipWebhookEventType;
  providerReference: string;
  localAttemptReference: string | null;
  orderReference: string | null;
  amountMinor: bigint;
  currency: MembershipPaymentCurrency;
  occurredAt: Date | null;
  payloadHash: string;
  sanitizedFact: Readonly<Record<string, string | null>>;
}

export interface MembershipWebhookProcessingResult {
  outcome: MembershipFulfillmentOutcome;
  reasonCode: string | null;
  settlementId: string | null;
  subscription: MembershipSubscription | null;
}

export interface RedeemMembershipCreditInput {
  userId: string;
  planVersionId: string;
  creditUnits: number;
  idempotencyKeyHash: string;
  requestHash: string;
  now: Date;
}

export interface MembershipCreditRedemptionResult {
  created: boolean;
  redemptionId: string;
  creditUnits: number;
  plan: MembershipPlanVersion;
  subscription: MembershipSubscription;
}

export interface MembershipFulfillmentSnapshot {
  webhookEvents: MembershipWebhookEvidence[];
  settlements: MembershipSettlement[];
  fulfillments: MembershipFulfillmentRecord[];
  subscriptions: MembershipSubscription[];
  subscriptionEvents: MembershipSubscriptionEvent[];
  redemptions: MembershipCreditRedemption[];
}

export interface MembershipWebhookEvidence {
  id: string;
  providerCode: string;
  eventKey: string;
  eventType: MembershipWebhookEventType;
  payloadHash: string;
  outcome: string;
  reasonCode: string | null;
  settlementId: string | null;
  receivedAt: Date;
}

export interface MembershipSettlement {
  id: string;
  providerCode: string;
  eventId: string;
  orderId: string;
  attemptId: string;
  userId: string;
  providerReference: string;
  amountMinor: bigint;
  currency: MembershipPaymentCurrency;
  settledAt: Date;
}

export type MembershipFulfillmentStatus = 'PENDING' | 'FULFILLED' | 'RETRYABLE' | 'REJECTED';

export interface MembershipFulfillmentRecord {
  id: string;
  settlementId: string;
  orderId: string;
  userId: string;
  status: MembershipFulfillmentStatus;
  subscriptionId: string | null;
  failureCode: string | null;
  updatedAt: Date;
}

export const MEMBERSHIP_SUBSCRIPTION_EVENT_TYPES = [
  'ACTIVATED',
  'EXPIRED',
  'RENEWED',
  'CANCELLED',
  'REVOKED',
] as const;
export type MembershipSubscriptionEventType = typeof MEMBERSHIP_SUBSCRIPTION_EVENT_TYPES[number];

export interface MembershipSubscriptionEvent {
  id: string;
  subscriptionId: string;
  userId: string;
  eventType: MembershipSubscriptionEventType;
  sourceId: string;
  startsAt: Date;
  endsAt: Date | null;
  occurredAt: Date;
}

export interface MembershipCreditRedemption {
  id: string;
  userId: string;
  planVersionId: string;
  subscriptionId: string;
  creditUnits: number;
  consumedReputationPoints: number;
  contractVersion: string;
  ruleVersion: string;
  idempotencyKeyHash: string;
  requestHash: string;
  createdAt: Date;
}

export interface MembershipSettlementContext {
  order: MembershipCheckoutOrder;
  attempt: MembershipPaymentAttempt;
  settlement: MembershipSettlement;
}

export const MEMBERSHIP_CREDIT_CONTRACT_VERSION = 'membership-contribution-credit-v1' as const;
export const MEMBERSHIP_CREDIT_RULE_VERSION = 'membership-credit-v1' as const;
export const MEMBERSHIP_CREDIT_MONTHS_PER_UNIT = 1 as const;
export const MEMBERSHIP_CREDIT_MAX_REDEMPTION_UNITS = 120 as const;
export const MEMBERSHIP_CREDIT_POINTS_PER_UNIT = 10 as const;

export function addMembershipPeriod(
  start: Date,
  periodUnit: MembershipPricePeriodUnit,
  periodCount: number,
): Date {
  if (
    !(start instanceof Date) || !Number.isFinite(start.getTime()) ||
    !Number.isSafeInteger(periodCount) || periodCount <= 0
  ) {
    throw new Error('Invalid membership period');
  }
  const months = periodUnit === 'YEAR' ? periodCount * 12 : periodCount;
  if (!Number.isSafeInteger(months) || months <= 0) throw new Error('Invalid membership period');

  const result = new Date(start);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export function cloneMembershipSubscription(value: MembershipSubscription): MembershipSubscription {
  return {
    ...value,
    startsAt: new Date(value.startsAt),
    endsAt: value.endsAt ? new Date(value.endsAt) : null,
    cancelledAt: value.cancelledAt ? new Date(value.cancelledAt) : null,
    revokedAt: value.revokedAt ? new Date(value.revokedAt) : null,
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
  };
}

export function isBlockingMembershipSubscription(
  subscription: MembershipSubscription,
  now: Date,
): boolean {
  if (subscription.status === 'SCHEDULED') return subscription.startsAt.getTime() > now.getTime();
  if (subscription.status !== 'ACTIVE') return false;
  if (subscription.startsAt.getTime() > now.getTime()) return true;
  return subscription.endsAt === null || subscription.endsAt.getTime() > now.getTime();
}
