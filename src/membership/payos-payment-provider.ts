import { createHash, createHmac } from 'node:crypto';
import {
  MembershipPaymentProviderError,
  type CreateMembershipCheckoutInput,
  type CreatedMembershipCheckout,
  type MembershipPaymentCapabilities,
  type MembershipPaymentProvider,
} from './membership.payment-provider';
import {
  isSafeMinorAmount,
  MEMBERSHIP_PAYMENT_CURRENCY,
} from './membership.payment.types';

const PAYOS_CREATE_PATH = '/v2/payment-requests';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TEXT = 512;

export interface PayOsPaymentProviderConfig {
  apiUrl?: string;
  clientId?: string;
  apiKey?: string;
  checksumKey?: string;
  qrEnabled: boolean;
  timeoutMs?: number;
  fetcher?: PayOsPaymentFetcher;
}

export interface PayOsPaymentRequestInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface PayOsPaymentHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type PayOsPaymentFetcher = (
  url: string,
  init: PayOsPaymentRequestInit,
) => Promise<PayOsPaymentHttpResponse>;

export interface PayOsCreatePaymentPayload {
  orderCode: number;
  amount: number;
  description: string;
  cancelUrl: string;
  returnUrl: string;
  expiredAt: number;
  signature: string;
}

export class PayOsMembershipPaymentProvider implements MembershipPaymentProvider {
  readonly code = 'payos';
  private readonly fetcher: PayOsPaymentFetcher;
  private readonly timeoutMs: number;

  constructor(private readonly config: PayOsPaymentProviderConfig) {
    this.fetcher = config.fetcher ?? defaultPayOsFetcher;
    this.timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs! > 0
      ? config.timeoutMs!
      : DEFAULT_TIMEOUT_MS;
  }

  isAvailable(): boolean {
    return this.getCapabilities().available;
  }

  getCapabilities(): MembershipPaymentCapabilities {
    const available = this.isConfigured();
    return {
      available,
      qrAvailable: available,
      provider: available ? this.code : null,
    };
  }

  async createCheckout(input: CreateMembershipCheckoutInput): Promise<CreatedMembershipCheckout> {
    if (!this.isConfigured()) throw new MembershipPaymentProviderError('UNAVAILABLE', false);
    assertCheckoutInput(input);

    const orderCode = derivePayOsOrderCode(input.localAttemptReference);
    const payload = buildPayOsCreatePaymentPayload(input, this.config.checksumKey!, orderCode);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: PayOsPaymentHttpResponse;
    try {
      response = await this.fetcher(`${this.config.apiUrl}${PAYOS_CREATE_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-client-id': this.config.clientId!,
          'x-api-key': this.config.apiKey!,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) throw new MembershipPaymentProviderError('TIMEOUT', true);
      throw new MembershipPaymentProviderError('UNAVAILABLE', true);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw new MembershipPaymentProviderError('REJECTED', true);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new MembershipPaymentProviderError('MALFORMED_RESPONSE', false);
    }
    return parsePayOsCheckoutResponse(body, input);
  }

  private isConfigured(): boolean {
    return this.config.qrEnabled === true
      && typeof this.config.apiUrl === 'string'
      && isPayOsApiUrl(this.config.apiUrl)
      && nonEmpty(this.config.clientId)
      && nonEmpty(this.config.apiKey)
      && nonEmpty(this.config.checksumKey);
  }
}

export function buildPayOsCreatePaymentPayload(
  input: CreateMembershipCheckoutInput,
  checksumKey: string,
  orderCode: number,
): PayOsCreatePaymentPayload {
  const amount = Number(input.amountMinor);
  const expiredAt = Math.floor(input.expiresAt.getTime() / 1000);
  const signature = createPayOsPaymentSignature({
    amount,
    cancelUrl: input.cancelUrl,
    description: input.description,
    orderCode,
    returnUrl: input.returnUrl,
  }, checksumKey);
  return {
    orderCode,
    amount,
    description: input.description,
    cancelUrl: input.cancelUrl,
    returnUrl: input.returnUrl,
    expiredAt,
    signature,
  };
}

export function createPayOsPaymentSignature(
  input: Omit<PayOsCreatePaymentPayload, 'signature' | 'expiredAt'>,
  checksumKey: string,
): string {
  const canonical = [
    `amount=${input.amount}`,
    `cancelUrl=${input.cancelUrl}`,
    `description=${input.description}`,
    `orderCode=${input.orderCode}`,
    `returnUrl=${input.returnUrl}`,
  ].join('&');
  return createHmac('sha256', checksumKey).update(canonical, 'utf8').digest('hex');
}

function parsePayOsCheckoutResponse(
  value: unknown,
  input: CreateMembershipCheckoutInput,
): CreatedMembershipCheckout {
  const root = asRecord(value);
  if (root.code !== '00' || root.success !== true) {
    throw new MembershipPaymentProviderError('REJECTED', false);
  }
  const data = asRecord(root.data);
  const providerReference = boundedReference(data.paymentLinkId);
  const checkoutUrl = boundedHttpsUrl(data.checkoutUrl);
  const amountMinor = parseResponseAmount(data.amount);
  const currency = data.currency;
  if (amountMinor !== input.amountMinor || currency !== MEMBERSHIP_PAYMENT_CURRENCY) {
    throw new MembershipPaymentProviderError('MALFORMED_RESPONSE', false);
  }
  return { providerReference, checkoutUrl, amountMinor, currency };
}

function assertCheckoutInput(input: CreateMembershipCheckoutInput): void {
  if (
    typeof input.localAttemptReference !== 'string' ||
    !/^cdn-mpay-[a-z0-9-]{1,120}$/iu.test(input.localAttemptReference) ||
    !isSafeMinorAmount(input.amountMinor) ||
    input.currency !== MEMBERSHIP_PAYMENT_CURRENCY ||
    !boundedText(input.description) ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    !isSafeRedirectUrl(input.returnUrl) ||
    !isSafeRedirectUrl(input.cancelUrl)
  ) {
    throw new MembershipPaymentProviderError('INVALID_REQUEST', false);
  }
}

function derivePayOsOrderCode(localAttemptReference: string): number {
  const digest = createHash('sha256').update(localAttemptReference, 'utf8').digest('hex');
  const value = BigInt(`0x${digest.slice(0, 12)}`) % 900_000_000_000n + 100_000_000_000n;
  return Number(value);
}

function parseResponseAmount(value: unknown): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === 'string' && /^\d{1,16}$/u.test(value)) return BigInt(value);
  throw new MembershipPaymentProviderError('MALFORMED_RESPONSE', false);
}

function boundedReference(value: unknown): string {
  if (!boundedText(value) || !/^[a-z0-9][a-z0-9._:-]{0,199}$/iu.test(value as string)) {
    throw new MembershipPaymentProviderError('MALFORMED_RESPONSE', false);
  }
  return value as string;
}

function boundedHttpsUrl(value: unknown): string {
  if (!boundedText(value)) throw new MembershipPaymentProviderError('MALFORMED_RESPONSE', false);
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    throw new MembershipPaymentProviderError('MALFORMED_RESPONSE', false);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new MembershipPaymentProviderError('MALFORMED_RESPONSE', false);
  }
  return url.toString();
}

function isSafeRedirectUrl(value: unknown): boolean {
  if (!boundedText(value)) return false;
  try {
    const url = new URL(value as string);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function isPayOsApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'api-merchant.payos.vn'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MembershipPaymentProviderError('MALFORMED_RESPONSE', false);
  }
  return value as Record<string, unknown>;
}

const defaultPayOsFetcher: PayOsPaymentFetcher = (url, init) => globalThis.fetch(url, init);
