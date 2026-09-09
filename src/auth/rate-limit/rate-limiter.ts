import { Injectable } from '@nestjs/common';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

interface Counter {
  count: number;
  resetAt: number;
}

@Injectable()
export class AuthRateLimiter {
  private readonly counters = new Map<string, Counter>();

  consume(key: string, rule: RateLimitRule, now = Date.now()): boolean {
    const current = this.counters.get(key);
    if (!current || current.resetAt <= now) {
      this.counters.set(key, { count: 1, resetAt: now + rule.windowMs });
      return true;
    }
    if (current.count >= rule.limit) return false;
    current.count += 1;
    return true;
  }

  clear(): void {
    this.counters.clear();
  }
}
