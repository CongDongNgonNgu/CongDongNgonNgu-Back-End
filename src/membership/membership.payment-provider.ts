import {
  MEMBERSHIP_PAYMENT_CURRENCY,
  type MembershipPaymentCurrency,
} from './membership.payment.types';

export const MEMBERSHIP_PAYMENT_PROVIDER = 'MEMBERSHIP_PAYMENT_PROVIDER';

export type MembershipPaymentProviderErrorCode =
  | 'DISABLED'
  | 'UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'MALFORMED_RESPONSE'
  | 'REJECTED'
  | 'TIMEOUT';

export class MembershipPaymentProviderError extends Error {
  readonly name = 'MembershipPaymentProviderError';

  constructor(
    readonly code: MembershipPaymentProviderErrorCode,
    readonly retryable: boolean,
  ) {
    super('Payment provider operation failed');
  }
}

export interface CreateMembershipCheckoutInput {
  localAttemptReference: string;
  amountMinor: bigint;
  currency: MembershipPaymentCurrency;
  description: string;
  expiresAt: Date;
}

export interface CreatedMembershipCheckout {
  providerReference: string;
  checkoutUrl: string;
  amountMinor?: bigint;
  currency?: MembershipPaymentCurrency;
}

export interface MembershipPaymentProvider {
  readonly code: string;
  isAvailable(): boolean;
  createCheckout(input: CreateMembershipCheckoutInput): Promise<CreatedMembershipCheckout>;
}

export class DisabledMembershipPaymentProvider implements MembershipPaymentProvider {
  readonly code: string;

  constructor(
    private readonly errorCode: 'DISABLED' | 'UNAVAILABLE' = 'DISABLED',
    code = 'disabled',
  ) {
    this.code = code;
  }

  isAvailable(): boolean {
    return false;
  }

  createCheckout(_input: CreateMembershipCheckoutInput): Promise<CreatedMembershipCheckout> {
    return Promise.reject(new MembershipPaymentProviderError(this.errorCode, false));
  }
}

export function createDisabledMembershipPaymentProvider(
  configured: boolean,
): MembershipPaymentProvider {
  return new DisabledMembershipPaymentProvider(
    configured ? 'UNAVAILABLE' : 'DISABLED',
    configured ? 'payos' : 'disabled',
  );
}

export function isSupportedMembershipCurrency(value: string): value is MembershipPaymentCurrency {
  return value === MEMBERSHIP_PAYMENT_CURRENCY;
}
