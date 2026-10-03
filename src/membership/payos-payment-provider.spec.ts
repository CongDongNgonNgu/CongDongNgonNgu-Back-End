import { describe, expect, it } from '@jest/globals';
import {
  buildPayOsCreatePaymentPayload,
  PayOsMembershipPaymentProvider,
  type PayOsPaymentProviderConfig,
} from './payos-payment-provider';

const input = {
  localAttemptReference: 'cdn-mpay-11111111-1111-4111-8111-111111111111',
  amountMinor: 125000n,
  currency: 'VND' as const,
  description: 'CongDongNgonNgu COMMUNITY_MEMBER v1',
  expiresAt: new Date('2026-10-03T12:15:00.000Z'),
  returnUrl: 'https://app.example.test/membership/checkout/order-1?status=success',
  cancelUrl: 'https://app.example.test/membership/checkout/order-1?status=cancelled',
};

function config(overrides: Partial<PayOsPaymentProviderConfig> = {}): PayOsPaymentProviderConfig {
  return {
    apiUrl: 'https://api-merchant.payos.vn',
    clientId: 'test-client-id',
    apiKey: 'test-api-key',
    checksumKey: 'test-checksum-key',
    qrEnabled: true,
    ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('PayOsMembershipPaymentProvider', () => {
  it('builds the documented sorted five-field HMAC signature without contacting PayOS', () => {
    const payload = buildPayOsCreatePaymentPayload(input, 'test-checksum-key', 123456789012);

    expect(payload).toMatchObject({
      orderCode: 123456789012,
      amount: 125000,
      description: input.description,
      returnUrl: input.returnUrl,
      cancelUrl: input.cancelUrl,
      expiredAt: 1791029700,
    });
    expect(payload.signature).toBe('6c914673201dd40801dd8576fe5e3c45628aa9f32ca575351e5bdbb040a12c58');
  });

  it('creates a checkout through an injected fake transport and validates the bounded response', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provider = new PayOsMembershipPaymentProvider(config({
      fetcher: async (url, init) => {
        calls.push({ url, init });
        return response({
          code: '00',
          desc: 'success',
          success: true,
          data: {
            paymentLinkId: 'payment-link-123',
            checkoutUrl: 'https://pay.payos.vn/web/abc',
            amount: 125000,
            currency: 'VND',
          },
        });
      },
    }));

    await expect(provider.createCheckout(input)).resolves.toEqual({
      providerReference: 'payment-link-123',
      checkoutUrl: 'https://pay.payos.vn/web/abc',
      amountMinor: 125000n,
      currency: 'VND',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api-merchant.payos.vn/v2/payment-requests');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({
      'x-client-id': 'test-client-id',
      'x-api-key': 'test-api-key',
    });
    expect(JSON.stringify(calls[0].init.body)).not.toContain('test-checksum-key');
  });

  it('fails closed when the QR kill switch is off or PayOS configuration is incomplete', async () => {
    const disabled = new PayOsMembershipPaymentProvider(config({ qrEnabled: false }));
    const incomplete = new PayOsMembershipPaymentProvider(config({ apiKey: undefined }));

    expect(disabled.isAvailable()).toBe(false);
    expect(disabled.getCapabilities()).toEqual({ available: false, qrAvailable: false, provider: null });
    expect(incomplete.getCapabilities()).toEqual({ available: false, qrAvailable: false, provider: null });
    await expect(disabled.createCheckout(input)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('rejects malformed or rejected provider responses without exposing provider details', async () => {
    const provider = new PayOsMembershipPaymentProvider(config({
      fetcher: async () => response({ code: '01', desc: 'secret provider detail', success: false }),
    }));

    await expect(provider.createCheckout(input)).rejects.toMatchObject({ code: 'REJECTED' });
  });
});
