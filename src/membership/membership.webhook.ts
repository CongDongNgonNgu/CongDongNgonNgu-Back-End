import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  MAX_SAFE_MINOR_UNITS,
  type MembershipPaymentCurrency,
} from './membership.payment.types';
import {
  PAYOS_PROVIDER_CODE,
  type MembershipWebhookEventType,
  type VerifiedMembershipWebhook,
} from './membership.fulfillment.types';

const MAX_PAYLOAD_TEXT = 512;
const MAX_EVENT_REFERENCE = 200;
const ALLOWED_PAYLOAD_KEYS = new Set(['code', 'desc', 'success', 'data', 'signature']);
const ALLOWED_DATA_KEYS = new Set([
  'orderCode',
  'amount',
  'description',
  'accountNumber',
  'reference',
  'transactionDateTime',
  'currency',
  'paymentLinkId',
  'code',
  'desc',
  'counterAccountBankId',
  'counterAccountBankName',
  'counterAccountName',
  'counterAccountNumber',
  'virtualAccountName',
  'virtualAccountNumber',
  'orderId',
  'localAttemptReference',
]);

export const MEMBERSHIP_WEBHOOK_VERIFIER = 'MEMBERSHIP_WEBHOOK_VERIFIER';

export type MembershipWebhookValidationCode =
  | 'WEBHOOK_UNAVAILABLE'
  | 'WEBHOOK_PAYLOAD_INVALID'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'WEBHOOK_EVENT_INVALID';

export class MembershipWebhookValidationError extends Error {
  readonly name = 'MembershipWebhookValidationError';

  constructor(readonly code: MembershipWebhookValidationCode, message: string) {
    super(message);
  }
}

export interface MembershipWebhookVerifier {
  verify(payload: unknown): VerifiedMembershipWebhook;
}

export class UnavailableMembershipWebhookVerifier implements MembershipWebhookVerifier {
  verify(_payload: unknown): VerifiedMembershipWebhook {
    throw new MembershipWebhookValidationError(
      'WEBHOOK_UNAVAILABLE',
      'Membership payment webhook verification is unavailable',
    );
  }
}

/**
 * PayOS webhook verification follows the provider's documented HMAC-SHA256
 * contract. It only parses bounded, non-secret payment facts; raw payloads
 * and the checksum key are never retained after verification.
 */
export class PayOsMembershipWebhookVerifier implements MembershipWebhookVerifier {
  private readonly checksumKey: string;

  constructor(checksumKey: string) {
    if (typeof checksumKey !== 'string' || checksumKey.trim().length === 0 || checksumKey.length > 512) {
      throw new Error('PAYOS_CHECKSUM_KEY is required for PayOS webhook verification');
    }
    this.checksumKey = checksumKey;
  }

  verify(payload: unknown): VerifiedMembershipWebhook {
    const root = asRecord(payload);
    assertExactKeys(root, ALLOWED_PAYLOAD_KEYS, 'WEBHOOK_PAYLOAD_INVALID');
    const code = boundedText(root.code, MAX_PAYLOAD_TEXT, 'WEBHOOK_PAYLOAD_INVALID');
    boundedText(root.desc, MAX_PAYLOAD_TEXT, 'WEBHOOK_PAYLOAD_INVALID');
    if (typeof root.success !== 'boolean') {
      throw invalidPayload();
    }
    const data = asRecord(root.data);
    assertExactKeys(data, ALLOWED_DATA_KEYS, 'WEBHOOK_PAYLOAD_INVALID');
    const signature = boundedText(root.signature, 128, 'WEBHOOK_SIGNATURE_INVALID');
    if (!/^[0-9a-f]{64}$/iu.test(signature)) throw invalidSignature();

    const canonical = Object.keys(data)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${key}=${canonicalPayOsValue(data[key])}`)
      .join('&');
    const expected = createHmac('sha256', this.checksumKey).update(canonical, 'utf8').digest('hex');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const actualBuffer = Buffer.from(signature.toLowerCase(), 'utf8');
    if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
      throw invalidSignature();
    }

    const orderCode = normalizeReference(data.orderCode, 'WEBHOOK_EVENT_INVALID');
    const amountMinor = parseAmount(data.amount);
    const currency = boundedText(data.currency, 16, 'WEBHOOK_EVENT_INVALID') as MembershipPaymentCurrency;
    if (currency !== 'VND') throw invalidEvent();
    const providerReference = firstReference(data.paymentLinkId, data.reference, orderCode);
    const localAttemptReference = extractLocalAttemptReference(data.localAttemptReference, data.description);
    const orderReference = extractOrderReference(data.orderId, orderCode);
    const eventType: MembershipWebhookEventType = root.success && code === '00' &&
      (data.code === undefined || data.code === '00')
      ? 'PAYMENT_SUCCEEDED'
      : 'PAYMENT_FAILED';
    const eventKey = digest(`${PAYOS_PROVIDER_CODE}\n${providerReference}\n${eventType}`);
    const occurredAt = parseOptionalDate(data.transactionDateTime);
    const payloadHash = digest(stableStringify(root));

    return {
      providerCode: PAYOS_PROVIDER_CODE,
      eventKey,
      eventType,
      providerReference,
      localAttemptReference,
      orderReference,
      amountMinor,
      currency,
      occurredAt,
      payloadHash,
      sanitizedFact: Object.freeze({
        providerCode: PAYOS_PROVIDER_CODE,
        eventKey,
        eventType,
        providerReference,
        localAttemptReference,
        orderReference,
        amountMinor: amountMinor.toString(10),
        currency,
        providerStatusCode: code,
        occurredAt: occurredAt?.toISOString() ?? null,
      }),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidPayload();
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  code: 'WEBHOOK_PAYLOAD_INVALID',
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new MembershipWebhookValidationError(code, 'Webhook payload contains unsupported fields');
  }
}

function boundedText(value: unknown, maxLength: number, code: MembershipWebhookValidationCode): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || value.trim().length === 0) {
    throw new MembershipWebhookValidationError(code, 'Webhook field is invalid');
  }
  return value;
}

function normalizeReference(value: unknown, code: MembershipWebhookValidationCode): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw new MembershipWebhookValidationError(code, 'Webhook reference is invalid');
    return String(value);
  }
  const reference = boundedText(value, MAX_EVENT_REFERENCE, code);
  if (!/^[a-z0-9][a-z0-9._:-]{0,199}$/iu.test(reference)) {
    throw new MembershipWebhookValidationError(code, 'Webhook reference is invalid');
  }
  return reference;
}

function parseAmount(value: unknown): bigint {
  let amount: bigint;
  try {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) throw new Error();
      amount = BigInt(value);
    } else if (typeof value === 'string' && /^\d{1,16}$/u.test(value)) {
      amount = BigInt(value);
    } else {
      throw new Error();
    }
  } catch {
    throw invalidEvent();
  }
  if (amount <= 0n || amount > MAX_SAFE_MINOR_UNITS) throw invalidEvent();
  return amount;
}

function firstReference(...values: unknown[]): string {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    return normalizeReference(value, 'WEBHOOK_EVENT_INVALID');
  }
  throw invalidEvent();
}

function extractLocalAttemptReference(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (/^cdn-mpay-[a-z0-9-]{1,120}$/iu.test(value)) return value;
  }
  return null;
}

function extractOrderReference(orderId: unknown, orderCode: string): string | null {
  if (typeof orderId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(orderId)) {
    return orderId;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(orderCode)) {
    return orderCode;
  }
  return null;
}

function parseOptionalDate(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const text = boundedText(value, 64, 'WEBHOOK_EVENT_INVALID');
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw invalidEvent();
  return date;
}

function canonicalPayOsValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return stableStringify(value);
  return String(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalidPayload(): MembershipWebhookValidationError {
  return new MembershipWebhookValidationError('WEBHOOK_PAYLOAD_INVALID', 'Webhook payload is invalid');
}

function invalidSignature(): MembershipWebhookValidationError {
  return new MembershipWebhookValidationError('WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid');
}

function invalidEvent(): MembershipWebhookValidationError {
  return new MembershipWebhookValidationError('WEBHOOK_EVENT_INVALID', 'Webhook event is invalid');
}
