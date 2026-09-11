import { Injectable } from '@nestjs/common';

interface Counter {
  count: number;
  resetAt: number;
}

export interface CommunityRateRule {
  limit: number;
  windowMs: number;
}

@Injectable()
export class CommunityRateLimiter {
  private readonly counters = new Map<string, Counter>();

  consume(
    operation: string,
    actorId: string,
    rule: CommunityRateRule,
    now = Date.now(),
  ): boolean {
    const key = operation + ':' + actorId;
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
