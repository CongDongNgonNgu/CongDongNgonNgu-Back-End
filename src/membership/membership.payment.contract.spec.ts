import { describe, expect, it } from '@jest/globals';
import {
  MAX_SAFE_MINOR_UNITS,
  isSafeMinorAmount,
  serializeMinorAmount,
  validateProviderCheckout,
} from './membership.payment.types';

describe('membership payment contracts', () => {
  it('accepts only positive, safe integer minor-unit amounts', () => {
    expect(isSafeMinorAmount(1n)).toBe(true);
    expect(isSafeMinorAmount(MAX_SAFE_MINOR_UNITS)).toBe(true);
    expect(isSafeMinorAmount(0n)).toBe(false);
    expect(isSafeMinorAmount(-1n)).toBe(false);
    expect(isSafeMinorAmount(MAX_SAFE_MINOR_UNITS + 1n)).toBe(false);
  });

  it('serializes money deterministically without floating point conversion', () => {
    expect(serializeMinorAmount(125000n)).toBe('125000');
    expect(() => serializeMinorAmount(0n)).toThrow('Invalid monetary amount');
  });

  it('rejects unsafe provider checkout responses', () => {
    expect(() => validateProviderCheckout({
      providerReference: 'provider-ref-1',
      checkoutUrl: 'https://pay.example/checkout/1',
    })).not.toThrow();
    expect(() => validateProviderCheckout({
      providerReference: '',
      checkoutUrl: 'https://pay.example/checkout/1',
    })).toThrow('Invalid payment provider response');
    expect(() => validateProviderCheckout({
      providerReference: 'provider-ref-1',
      checkoutUrl: 'http://pay.example/checkout/1',
    })).toThrow('Invalid payment provider response');
    expect(() => validateProviderCheckout({
      providerReference: 'provider-ref-1',
      checkoutUrl: 'https://pay.example/checkout/1',
      amountMinor: 999n,
    }, { amountMinor: 1000n, currency: 'VND' })).toThrow('Invalid payment provider response');
  });
});
