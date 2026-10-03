import {
  isUuid,
  type MembershipPublicBenefit,
} from './membership.types';

export const MEMBERSHIP_PAYMENT_CURRENCY = 'VND' as const;
export type MembershipPaymentCurrency = typeof MEMBERSHIP_PAYMENT_CURRENCY;

export const MEMBERSHIP_PRICE_STATUSES = ['ACTIVE', 'RETIRED'] as const;
export type MembershipPriceStatus = typeof MEMBERSHIP_PRICE_STATUSES[number];

export const MEMBERSHIP_PRICE_PERIOD_UNITS = ['MONTH', 'YEAR'] as const;
export type MembershipPricePeriodUnit = typeof MEMBERSHIP_PRICE_PERIOD_UNITS[number];

export const MEMBERSHIP_ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAID',
  'FAILED',
  'CANCELLED',
] as const;
export type MembershipOrderStatus = typeof MEMBERSHIP_ORDER_STATUSES[number];

export const MEMBERSHIP_PAYMENT_ATTEMPT_STATUSES = [
  'CREATED',
  'PENDING',
  'PAID',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type MembershipPaymentAttemptStatus = typeof MEMBERSHIP_PAYMENT_ATTEMPT_STATUSES[number];

export const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);
export const PAYMENT_ATTEMPT_LIFETIME_MS = 15 * 60 * 1_000;

export interface MembershipPlanPrice {
  id: string;
  planVersionId: string;
  code: string;
  status: MembershipPriceStatus;
  amountMinor: bigint;
  currency: MembershipPaymentCurrency;
  periodUnit: MembershipPricePeriodUnit;
  periodCount: number;
  availableFrom: Date;
  availableUntil: Date | null;
  createdAt: Date;
}

export interface MembershipPaymentCatalogEntry {
  planVersionId: string;
  productCode: string;
  productStatus: 'ACTIVE' | 'RETIRED';
  planVersion: number;
  planStatus: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  planDisplayName: string;
  planDescription?: string;
  price: MembershipPlanPrice;
}

export interface MembershipCatalogPlanResponse {
  planVersionId: string;
  productCode: string;
  planVersion: number;
  displayName: string;
  description: string;
  benefits: MembershipPublicBenefit[];
  price: {
    id: string;
    code: string;
    amountMinor: string;
    currency: MembershipPaymentCurrency;
    periodUnit: MembershipPricePeriodUnit;
    periodCount: number;
  };
}

export interface MembershipCatalogResponse {
  free: {
    productCode: 'FREE';
    planVersion: 1;
    displayName: string;
    description: string;
    benefits: MembershipPublicBenefit[];
  };
  plans: MembershipCatalogPlanResponse[];
  payment: {
    available: boolean;
    qrAvailable: boolean;
    provider: string | null;
  };
  evaluatedAt: string;
}

export interface MembershipCheckoutOrder {
  id: string;
  userId: string;
  planVersionId: string;
  priceId: string;
  productCode: string;
  planVersion: number;
  planDisplayName: string;
  priceCode: string;
  amountMinor: bigint;
  currency: MembershipPaymentCurrency;
  periodUnit: MembershipPricePeriodUnit;
  periodCount: number;
  status: MembershipOrderStatus;
  idempotencyKeyHash: string;
  requestHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MembershipPaymentAttempt {
  id: string;
  userId: string;
  orderId: string;
  providerCode: string;
  localAttemptReference: string;
  providerReference: string | null;
  checkoutUrl: string | null;
  amountMinor: bigint;
  currency: MembershipPaymentCurrency;
  status: MembershipPaymentAttemptStatus;
  idempotencyKeyHash: string;
  requestHash: string;
  expiresAt: Date;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MembershipPaymentAttemptResponse {
  id: string;
  orderId: string;
  status: MembershipPaymentAttemptStatus;
  amountMinor: string;
  currency: MembershipPaymentCurrency;
  checkoutUrl: string | null;
  expiresAt: string;
}

export interface MembershipCheckoutOrderResponse {
  id: string;
  status: MembershipOrderStatus;
  product: {
    code: string;
    planVersion: number;
    displayName: string;
  };
  price: {
    code: string;
    amountMinor: string;
    currency: MembershipPaymentCurrency;
    periodUnit: MembershipPricePeriodUnit;
    periodCount: number;
  };
  createdAt: string;
  updatedAt: string;
  attempt: MembershipPaymentAttemptResponse | null;
}

export function isSafeMinorAmount(value: bigint): boolean {
  return typeof value === 'bigint' && value > 0n && value <= MAX_SAFE_MINOR_UNITS;
}

export function serializeMinorAmount(value: bigint): string {
  if (!isSafeMinorAmount(value)) throw new Error('Invalid monetary amount');
  return value.toString(10);
}

export function validateProviderCheckout(value: {
  providerReference?: unknown;
  checkoutUrl?: unknown;
  amountMinor?: unknown;
  currency?: unknown;
}, expected?: { amountMinor: bigint; currency: MembershipPaymentCurrency }): void {
  if (
    typeof value.providerReference !== 'string' ||
    value.providerReference.length < 1 ||
    value.providerReference.length > 200 ||
    typeof value.checkoutUrl !== 'string' ||
    !isSafeProviderUrl(value.checkoutUrl) ||
    (value.amountMinor !== undefined && (
      typeof value.amountMinor !== 'bigint' || !isSafeMinorAmount(value.amountMinor)
    )) ||
    (value.currency !== undefined && value.currency !== MEMBERSHIP_PAYMENT_CURRENCY) ||
    (expected !== undefined && value.amountMinor !== undefined && value.amountMinor !== expected.amountMinor) ||
    (expected !== undefined && value.currency !== undefined && value.currency !== expected.currency)
  ) {
    throw new Error('Invalid payment provider response');
  }
}

export function isSafeProviderUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function isValidPaymentIdentifier(value: string): boolean {
  return isUuid(value);
}

export function clonePaymentCatalogEntry(value: MembershipPaymentCatalogEntry): MembershipPaymentCatalogEntry {
  return {
    ...value,
    price: {
      ...value.price,
      amountMinor: BigInt(value.price.amountMinor),
      availableFrom: new Date(value.price.availableFrom),
      availableUntil: value.price.availableUntil ? new Date(value.price.availableUntil) : null,
      createdAt: new Date(value.price.createdAt),
    },
  };
}

export function cloneCheckoutOrder(value: MembershipCheckoutOrder): MembershipCheckoutOrder {
  return {
    ...value,
    amountMinor: BigInt(value.amountMinor),
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
  };
}

export function clonePaymentAttempt(value: MembershipPaymentAttempt): MembershipPaymentAttempt {
  return {
    ...value,
    amountMinor: BigInt(value.amountMinor),
    expiresAt: new Date(value.expiresAt),
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
  };
}
