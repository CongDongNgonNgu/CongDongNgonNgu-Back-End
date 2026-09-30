import { describe, expect, it } from '@jest/globals';
import {
  estimateAiCost,
  InMemoryAiQuotaLedger,
  InMemoryAiRateLimiter,
} from './ai.usage';

describe('InMemoryAiQuotaLedger', () => {
  it('reserves concurrent token budgets before either request settles', () => {
    const ledger = new InMemoryAiQuotaLedger();
    const first = ledger.reserve({
      quotaKey: 'free:user-1',
      requestedTokens: 70,
      maxTokensPerWindow: 100,
      windowMs: 60_000,
      now: 1_000,
    });

    expect(() => ledger.reserve({
      quotaKey: 'free:user-1',
      requestedTokens: 40,
      maxTokensPerWindow: 100,
      windowMs: 60_000,
      now: 1_001,
    })).toThrow('AI token quota exceeded');

    ledger.settle(first, 55);
    expect(ledger.getSnapshot('free:user-1')).toEqual({ usedTokens: 55, reservedTokens: 0 });
  });

  it('releases a reservation without charging tokens', () => {
    const ledger = new InMemoryAiQuotaLedger();
    const reservation = ledger.reserve({
      quotaKey: 'free:user-2',
      requestedTokens: 30,
      maxTokensPerWindow: 100,
      windowMs: 60_000,
    });

    ledger.release(reservation);
    ledger.release(reservation);
    expect(ledger.getSnapshot('free:user-2')).toEqual({ usedTokens: 0, reservedTokens: 0 });
  });
});

describe('InMemoryAiRateLimiter', () => {
  it('allows the configured number of requests and resets at the window boundary', () => {
    const limiter = new InMemoryAiRateLimiter();

    expect(limiter.consume('user-1', 2, 60_000, 1_000)).toBe(true);
    expect(limiter.consume('user-1', 2, 60_000, 1_001)).toBe(true);
    expect(limiter.consume('user-1', 2, 60_000, 1_002)).toBe(false);
    expect(limiter.consume('user-1', 2, 60_000, 61_001)).toBe(true);
  });
});

describe('estimateAiCost', () => {
  it('returns a deterministic estimate from provider-reported token usage', () => {
    expect(estimateAiCost({
      providerId: 'provider',
      modelId: 'model',
      supportsStreaming: false,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      inputCostPerMillionUsd: 1,
      outputCostPerMillionUsd: 2,
    }, { inputTokens: 12, outputTokens: 6 })).toBe(0.000024);
  });

  it('returns null when pricing is not declared', () => {
    expect(estimateAiCost({
      providerId: 'provider',
      modelId: 'model',
      supportsStreaming: true,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      inputCostPerMillionUsd: null,
      outputCostPerMillionUsd: null,
    }, { inputTokens: 12, outputTokens: 6 })).toBeNull();
  });
});
