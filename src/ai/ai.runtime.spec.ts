import { describe, expect, it } from '@jest/globals';
import {
  AiProviderError,
  type AiCompletionResult,
  type AiModelCapability,
  type AiProviderAdapter,
} from './ai.types';
import {
  AiProviderRegistry,
  FailClosedAiProviderAdapter,
} from './ai.provider';
import {
  InMemoryAiQuotaLedger,
  InMemoryAiRateLimiter,
  InMemoryAiUsageLedger,
  StaticAiUsagePolicyResolver,
} from './ai.usage';
import { AiRuntimeService } from './ai.runtime';

const capability: AiModelCapability = {
  providerId: 'test-provider',
  modelId: 'test-model',
  supportsStreaming: false,
  maxInputTokens: 1_000,
  maxOutputTokens: 500,
  inputCostPerMillionUsd: 1,
  outputCostPerMillionUsd: 2,
};

class FakeAiProvider implements AiProviderAdapter {
  readonly providerId = capability.providerId;
  readonly state = 'available' as const;
  readonly capabilities = [capability];
  readonly calls: string[] = [];

  constructor(private readonly outcomes: Array<AiCompletionResult | Error>) {}

  async complete(request: { requestId: string }): Promise<AiCompletionResult> {
    this.calls.push(request.requestId);
    const outcome = this.outcomes.shift();
    if (!outcome) throw new Error('Fake provider ran out of outcomes');
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

class HangingAiProvider implements AiProviderAdapter {
  readonly providerId = capability.providerId;
  readonly state = 'available' as const;
  readonly capabilities = [capability];

  async complete(_request: Parameters<AiProviderAdapter['complete']>[0], signal: AbortSignal): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(new AiProviderError('TIMEOUT', 'Provider aborted', true));
      }, { once: true });
    });
  }
}

function successResult(): AiCompletionResult {
  return {
    text: 'A safe test response',
    usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 },
    finishReason: 'stop',
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'request-09a-001',
    userId: 'user-09a-001',
    feature: 'conversation',
    modelId: capability.modelId,
    messages: [{ role: 'user' as const, content: 'Hello' }],
    estimatedInputTokens: 12,
    maxOutputTokens: 20,
    ...overrides,
  };
}

function buildRuntime(
  adapter: AiProviderAdapter,
  policy = {
    quotaKey: 'user-09a-001',
    maxTokensPerWindow: 1_000,
    quotaWindowMs: 60 * 60 * 1_000,
    rateLimitKey: 'user-09a-001:conversation',
    maxRequestsPerWindow: 5,
    rateLimitWindowMs: 60 * 1_000,
  },
) {
  const usage = new InMemoryAiUsageLedger();
  const quota = new InMemoryAiQuotaLedger();
  const runtime = new AiRuntimeService(
    new AiProviderRegistry([adapter]),
    usage,
    new StaticAiUsagePolicyResolver(policy),
    quota,
    new InMemoryAiRateLimiter(),
    { timeoutMs: 50, maxAttempts: 2, retryDelayMs: 0 },
  );
  return { runtime, usage, quota };
}

describe('AiRuntimeService', () => {
  it('fails closed when the provider is disabled', async () => {
    const { runtime } = buildRuntime(
      new FailClosedAiProviderAdapter('configured', 'disabled', 'AI provider is disabled'),
    );

    await expect(runtime.complete(input())).rejects.toMatchObject({
      code: 'AI_PROVIDER_UNAVAILABLE',
    });
  });

  it('retries a retryable provider error without double-recording successful usage', async () => {
    const provider = new FakeAiProvider([
      new AiProviderError('TIMEOUT', 'Provider timed out', true),
      successResult(),
    ]);
    const { runtime, usage, quota } = buildRuntime(provider);

    const result = await runtime.complete(input());

    expect(result).toMatchObject({
      providerId: 'test-provider',
      modelId: 'test-model',
      attempts: 2,
      usage: successResult().usage,
    });
    expect(provider.calls).toEqual(['request-09a-001', 'request-09a-001']);
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 2,
      totalTokens: 18,
      estimatedCostUsd: 0.000024,
    });
    expect(quota.getSnapshot('user-09a-001')).toMatchObject({
      usedTokens: 18,
      reservedTokens: 0,
    });
  });

  it('rejects before calling a provider when the per-user rate limit is exhausted', async () => {
    const provider = new FakeAiProvider([successResult()]);
    const { runtime, usage } = buildRuntime(provider, {
      quotaKey: 'user-09a-001',
      maxTokensPerWindow: 1_000,
      quotaWindowMs: 60 * 60 * 1_000,
      rateLimitKey: 'user-09a-001:conversation',
      maxRequestsPerWindow: 0,
      rateLimitWindowMs: 60 * 1_000,
    });

    await expect(runtime.complete(input())).rejects.toMatchObject({
      code: 'AI_RATE_LIMITED',
    });
    expect(provider.calls).toHaveLength(0);
    expect(usage.records[0]).toMatchObject({ status: 'REJECTED', errorCode: 'AI_RATE_LIMITED' });
  });

  it('rejects before calling a provider when the entitlement quota cannot reserve the request', async () => {
    const provider = new FakeAiProvider([successResult()]);
    const { runtime, usage } = buildRuntime(provider, {
      quotaKey: 'free:user-09a-001',
      maxTokensPerWindow: 20,
      quotaWindowMs: 60 * 60 * 1_000,
      rateLimitKey: 'user-09a-001:conversation',
      maxRequestsPerWindow: 5,
      rateLimitWindowMs: 60 * 1_000,
    });

    await expect(runtime.complete(input())).rejects.toMatchObject({
      code: 'AI_QUOTA_EXCEEDED',
    });
    expect(provider.calls).toHaveLength(0);
    expect(usage.records[0]).toMatchObject({ status: 'REJECTED', errorCode: 'AI_QUOTA_EXCEEDED' });
  });

  it('rejects invalid provider usage and releases the reservation', async () => {
    const provider = new FakeAiProvider([{
      text: 'invalid usage',
      usage: { inputTokens: 12, outputTokens: 6, totalTokens: 99 },
      finishReason: 'stop',
    }]);
    const { runtime, usage, quota } = buildRuntime(provider);

    await expect(runtime.complete(input())).rejects.toMatchObject({
      code: 'AI_INVALID_RESPONSE',
    });
    expect(usage.records[0]).toMatchObject({ status: 'FAILED', errorCode: 'AI_INVALID_RESPONSE' });
    expect(quota.getSnapshot('user-09a-001')).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
    });
  });

  it('validates structured output before recording successful usage', async () => {
    const provider = new FakeAiProvider([{
      text: '{"kind":"WRITING_CORRECTION"}',
      usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 },
      finishReason: 'stop',
    }]);
    const { runtime, usage, quota } = buildRuntime(provider);

    await expect(runtime.complete(input({
      structuredOutputKind: 'WRITING_CORRECTION',
    }))).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({ status: 'FAILED', errorCode: 'AI_INVALID_RESPONSE' });
    expect(quota.getSnapshot('user-09a-001')).toEqual({ usedTokens: 0, reservedTokens: 0 });
  });

  it('converts bounded provider timeouts into a safe runtime error after retries', async () => {
    const { runtime, usage, quota } = buildRuntime(new HangingAiProvider());

    await expect(runtime.complete(input())).rejects.toMatchObject({
      code: 'AI_PROVIDER_TIMEOUT',
    });
    expect(usage.records[0]).toMatchObject({
      status: 'FAILED',
      attempts: 2,
      errorCode: 'AI_PROVIDER_TIMEOUT',
    });
    expect(quota.getSnapshot('user-09a-001')).toEqual({ usedTokens: 0, reservedTokens: 0 });
  });

  it('rejects malformed message content before policy or provider execution', async () => {
    const provider = new FakeAiProvider([successResult()]);
    const { runtime } = buildRuntime(provider);

    await expect(runtime.complete(input({
      messages: [{ role: 'user', content: 42 }],
    }))).rejects.toMatchObject({ code: 'AI_REQUEST_INVALID' });
    expect(provider.calls).toHaveLength(0);
  });

  it('rejects a missing request object with a domain error', async () => {
    const provider = new FakeAiProvider([successResult()]);
    const { runtime } = buildRuntime(provider);

    await expect(runtime.complete(undefined as never)).rejects.toMatchObject({
      code: 'AI_REQUEST_INVALID',
    });
    expect(provider.calls).toHaveLength(0);
  });
});
