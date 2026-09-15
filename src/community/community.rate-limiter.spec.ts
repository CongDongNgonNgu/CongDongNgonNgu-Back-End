import { describe, expect, it } from '@jest/globals';
import { CommunityRateLimiter } from './community.rate-limiter';

describe('CommunityRateLimiter', () => {
  it('rejects only after the configured boundary and resets at the window', () => {
    const limiter = new CommunityRateLimiter();
    const rule = { limit: 2, windowMs: 1_000 };

    expect(limiter.consume('post', 'user-a', rule, 10_000)).toBe(true);
    expect(limiter.consume('post', 'user-a', rule, 10_001)).toBe(true);
    expect(limiter.consume('post', 'user-a', rule, 10_002)).toBe(false);
    expect(limiter.consume('post', 'user-a', rule, 11_000)).toBe(true);
  });

  it('keeps actor and operation buckets independent', () => {
    const limiter = new CommunityRateLimiter();
    const rule = { limit: 1, windowMs: 1_000 };

    expect(limiter.consume('post', 'user-a', rule, 10_000)).toBe(true);
    expect(limiter.consume('post', 'user-a', rule, 10_001)).toBe(false);
    expect(limiter.consume('comment', 'user-a', rule, 10_001)).toBe(true);
    expect(limiter.consume('post', 'user-b', rule, 10_001)).toBe(true);
  });
});
