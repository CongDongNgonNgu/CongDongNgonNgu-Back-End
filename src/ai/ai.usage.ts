import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  AiModelCapability,
  AiQuotaLedger,
  AiQuotaReservation,
  AiRateLimiter,
  AiUsageLedger,
  AiUsagePolicy,
  AiUsagePolicyResolver,
  AiUsageRecord,
} from './ai.types';

export class AiUsagePolicyError extends Error {
  readonly name = 'AiUsagePolicyError';

  constructor(readonly code: 'AI_QUOTA_EXCEEDED' | 'AI_POLICY_UNAVAILABLE', message: string) {
    super(message);
  }
}

export class AiRateLimitError extends Error {
  readonly name = 'AiRateLimitError';
  readonly code = 'AI_RATE_LIMITED' as const;

  constructor(message = 'AI request rate limit exceeded') {
    super(message);
  }
}

@Injectable()
export class InMemoryAiUsageLedger implements AiUsageLedger {
  readonly records: AiUsageRecord[] = [];

  async append(record: AiUsageRecord): Promise<void> {
    this.records.push({
      ...record,
      occurredAt: new Date(record.occurredAt),
    });
  }
}

interface QuotaWindow {
  usedTokens: number;
  reservedTokens: number;
}

interface ReservationState extends AiQuotaReservation {
  windowKey: string;
}

@Injectable()
export class InMemoryAiQuotaLedger implements AiQuotaLedger {
  private readonly windows = new Map<string, QuotaWindow>();
  private readonly reservations = new Map<string, ReservationState>();

  reserve(input: {
    quotaKey: string;
    requestedTokens: number;
    maxTokensPerWindow: number;
    windowMs: number;
    now?: number;
  }): AiQuotaReservation {
    if (
      !input.quotaKey ||
      !Number.isInteger(input.requestedTokens) ||
      input.requestedTokens < 0 ||
      !Number.isInteger(input.maxTokensPerWindow) ||
      input.maxTokensPerWindow < 0 ||
      !Number.isInteger(input.windowMs) ||
      input.windowMs <= 0
    ) {
      throw new AiUsagePolicyError('AI_POLICY_UNAVAILABLE', 'AI quota policy is invalid');
    }
    const windowStartedAt = Math.floor((input.now ?? Date.now()) / input.windowMs) * input.windowMs;
    const windowKey = `${input.quotaKey}:${windowStartedAt}`;
    const window = this.windows.get(windowKey) ?? { usedTokens: 0, reservedTokens: 0 };
    if (
      window.usedTokens + window.reservedTokens + input.requestedTokens
      > input.maxTokensPerWindow
    ) {
      throw new AiUsagePolicyError('AI_QUOTA_EXCEEDED', 'AI token quota exceeded');
    }
    window.reservedTokens += input.requestedTokens;
    this.windows.set(windowKey, window);
    const reservation: ReservationState = {
      id: randomUUID(),
      quotaKey: input.quotaKey,
      windowStartedAt,
      reservedTokens: input.requestedTokens,
      windowKey,
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  settle(reservation: AiQuotaReservation, actualTokens: number): void {
    const current = this.reservations.get(reservation.id);
    if (!current || !Number.isInteger(actualTokens) || actualTokens < 0 || actualTokens > current.reservedTokens) {
      throw new AiUsagePolicyError('AI_POLICY_UNAVAILABLE', 'AI quota reservation is invalid');
    }
    const window = this.windows.get(current.windowKey);
    if (!window) throw new AiUsagePolicyError('AI_POLICY_UNAVAILABLE', 'AI quota window is unavailable');
    window.reservedTokens -= current.reservedTokens;
    window.usedTokens += actualTokens;
    this.reservations.delete(current.id);
  }

  release(reservation: AiQuotaReservation): void {
    const current = this.reservations.get(reservation.id);
    if (!current) return;
    const window = this.windows.get(current.windowKey);
    if (window) window.reservedTokens -= current.reservedTokens;
    this.reservations.delete(current.id);
  }

  getSnapshot(quotaKey: string): { usedTokens: number; reservedTokens: number } {
    let usedTokens = 0;
    let reservedTokens = 0;
    for (const [windowKey, window] of this.windows) {
      if (windowKey.startsWith(`${quotaKey}:`)) {
        usedTokens += window.usedTokens;
        reservedTokens += window.reservedTokens;
      }
    }
    return { usedTokens, reservedTokens };
  }
}

@Injectable()
export class InMemoryAiRateLimiter implements AiRateLimiter {
  private readonly counters = new Map<string, { count: number; resetAt: number }>();

  consume(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const current = this.counters.get(key);
    if (!current || current.resetAt <= now) {
      this.counters.set(key, { count: 1, resetAt: now + windowMs });
      return limit >= 1;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }
}

@Injectable()
export class StaticAiUsagePolicyResolver implements AiUsagePolicyResolver {
  constructor(private readonly policy: AiUsagePolicy | null) {}

  async resolve(): Promise<AiUsagePolicy | null> {
    return this.policy;
  }
}

@Injectable()
export class FailClosedAiUsagePolicyResolver implements AiUsagePolicyResolver {
  async resolve(): Promise<AiUsagePolicy | null> {
    return null;
  }
}

export function estimateAiCost(
  capability: AiModelCapability,
  usage: { inputTokens: number; outputTokens: number },
): number | null {
  if (capability.inputCostPerMillionUsd === null || capability.outputCostPerMillionUsd === null) {
    return null;
  }
  const cost = (
    usage.inputTokens * capability.inputCostPerMillionUsd
    + usage.outputTokens * capability.outputCostPerMillionUsd
  ) / 1_000_000;
  return Number(cost.toFixed(6));
}
