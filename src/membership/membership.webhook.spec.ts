import { describe, expect, it } from '@jest/globals';
import { createHmac } from 'node:crypto';
import { PayOsMembershipWebhookVerifier, MembershipWebhookValidationError } from './membership.webhook';

const SECRET = 'webhook-test-secret';

function makePayload(dataOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    orderCode: '123456789',
    amount: 125000,
    description: 'cdn-mpay-test-reference',
    reference: 'bank-ref-1',
    transactionDateTime: '2026-10-01T12:00:00+07:00',
    currency: 'VND',
    paymentLinkId: 'payment-link-1',
    code: '00',
    desc: 'OK',
    ...dataOverrides,
  };
  const canonical = Object.keys(data)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${key}=${data[key] ?? ''}`)
    .join('&');
  return {
    code: data.code === '00' ? '00' : '01',
    desc: data.code === '00' ? 'OK' : 'Failed',
    success: data.code === '00',
    data,
    signature: createHmac('sha256', SECRET).update(canonical, 'utf8').digest('hex'),
  };
}

describe('PayOsMembershipWebhookVerifier', () => {
  it('verifies the sorted HMAC data contract and emits bounded canonical facts', () => {
    const result = new PayOsMembershipWebhookVerifier(SECRET).verify(makePayload());

    expect(result).toMatchObject({
      providerCode: 'payos',
      eventType: 'PAYMENT_SUCCEEDED',
      providerReference: 'payment-link-1',
      amountMinor: 125000n,
      currency: 'VND',
    });
    expect(result.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.sanitizedFact).not.toHaveProperty('signature');
  });

  it('rejects missing/altered signatures and invalid monetary facts', () => {
    const verifier = new PayOsMembershipWebhookVerifier(SECRET);
    const missing = makePayload();
    delete missing.signature;
    expect(() => verifier.verify(missing)).toThrow(MembershipWebhookValidationError);

    const altered = makePayload();
    altered.signature = '0'.repeat(64);
    expect(() => verifier.verify(altered)).toThrow('Webhook signature is invalid');

    expect(() => verifier.verify(makePayload({ amount: '0' }))).toThrow('Webhook event is invalid');
  });

  it('classifies an explicitly failed provider event without treating it as settlement', () => {
    const result = new PayOsMembershipWebhookVerifier(SECRET).verify(makePayload({ code: '01' }));
    expect(result.eventType).toBe('PAYMENT_FAILED');
  });
});
