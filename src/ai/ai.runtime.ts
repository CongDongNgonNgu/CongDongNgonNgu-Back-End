import { Inject, Injectable } from '@nestjs/common';
import {
  AI_QUOTA_LEDGER,
  AI_RATE_LIMITER,
  AI_RUNTIME_POLICY,
  AI_USAGE_LEDGER,
  AI_USAGE_POLICY_RESOLVER,
  type AiCompletionInput,
  type AiCompletionResponse,
  type AiCompletionResult,
  type AiModelCapability,
  AiProviderError,
  type AiProviderAdapter,
  type AiQuotaLedger,
  type AiRateLimiter,
  type AiRuntimePolicy,
  type AiUsageLedger,
  type AiUsagePolicy,
  type AiUsagePolicyResolver,
} from './ai.types';
import { AiAvailabilityError, AiProviderRegistry } from './ai.provider';
import { AiContractError } from './ai.contracts';
import { AI_STRUCTURED_OUTPUT_KINDS, parseAiStructuredOutput } from './ai.outputs';
import {
  AiRateLimitError,
  AiUsagePolicyError,
  estimateAiCost,
} from './ai.usage';

export type AiRuntimeErrorCode =
  | 'AI_REQUEST_INVALID'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_MODEL_UNAVAILABLE'
  | 'AI_POLICY_UNAVAILABLE'
  | 'AI_QUOTA_EXCEEDED'
  | 'AI_RATE_LIMITED'
  | 'AI_INVALID_RESPONSE'
  | 'AI_PROVIDER_TIMEOUT'
  | 'AI_PROVIDER_ERROR';

export class AiRuntimeError extends Error {
  readonly name = 'AiRuntimeError';

  constructor(readonly code: AiRuntimeErrorCode, message: string) {
    super(message);
  }
}

@Injectable()
export class AiRuntimeService {
  constructor(
    private readonly providers: AiProviderRegistry,
    @Inject(AI_USAGE_LEDGER)
    private readonly usage: AiUsageLedger,
    @Inject(AI_USAGE_POLICY_RESOLVER)
    private readonly policies: AiUsagePolicyResolver,
    @Inject(AI_QUOTA_LEDGER)
    private readonly quota: AiQuotaLedger,
    @Inject(AI_RATE_LIMITER)
    private readonly rateLimiter: AiRateLimiter,
    @Inject(AI_RUNTIME_POLICY)
    private readonly runtimePolicy: AiRuntimePolicy,
  ) {}

  async complete(input: AiCompletionInput): Promise<AiCompletionResponse> {
    this.validateRuntimePolicy();
    const modelId = (
      input &&
      typeof input === 'object' &&
      'modelId' in input &&
      typeof input.modelId === 'string'
    ) ? input.modelId : undefined;
    if (!modelId?.trim()) {
      throw new AiRuntimeError('AI_REQUEST_INVALID', 'AI completion request is invalid');
    }
    const selection = this.providers.resolve(modelId);
    this.validateRequest(input, selection.capability);
    const policy = await this.policies.resolve({
      userId: input.userId,
      entitlementKey: input.entitlementKey,
    });
    if (!policy) {
      const error = new AiRuntimeError('AI_POLICY_UNAVAILABLE', 'AI usage policy is unavailable');
      await this.recordRejected(input, selection.capability, error);
      throw error;
    }
    try {
      this.validatePolicy(policy);
    } catch (error) {
      const normalized = this.normalizeError(error);
      await this.recordRejected(input, selection.capability, normalized);
      throw normalized;
    }
    if (!this.rateLimiter.consume(
      policy.rateLimitKey,
      policy.maxRequestsPerWindow,
      policy.rateLimitWindowMs,
    )) {
      const error = new AiRateLimitError();
      await this.recordRejected(input, selection.capability, error);
      throw error;
    }

    let reservation;
    try {
      reservation = this.quota.reserve({
        quotaKey: policy.quotaKey,
        requestedTokens: input.estimatedInputTokens + input.maxOutputTokens,
        maxTokensPerWindow: policy.maxTokensPerWindow,
        windowMs: policy.quotaWindowMs,
      });
    } catch (error) {
      const normalized = this.normalizeError(error);
      await this.recordRejected(input, selection.capability, normalized);
      throw normalized;
    }

    let attempts = 0;
    try {
      while (attempts < this.runtimePolicy.maxAttempts) {
        attempts += 1;
        try {
          const result = await this.completeWithTimeout(selection.adapter, input);
          this.validateResult(
            result,
            selection.capability,
            input.maxOutputTokens,
            reservation.reservedTokens,
            input.structuredOutputKind,
          );
          const estimatedCostUsd = estimateAiCost(selection.capability, result.usage);
          this.quota.settle(reservation, result.usage.totalTokens);
          await this.usage.append({
            requestId: input.requestId,
            userId: input.userId,
            feature: input.feature,
            providerId: selection.capability.providerId,
            modelId: selection.capability.modelId,
            attempts,
            status: 'SUCCEEDED',
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
            estimatedCostUsd,
            occurredAt: new Date(),
          });
          return {
            ...result,
            providerId: selection.capability.providerId,
            modelId: selection.capability.modelId,
            attempts,
            estimatedCostUsd,
          };
        } catch (error) {
          const normalized = this.normalizeError(error);
          if (!this.isRetryable(error) || attempts >= this.runtimePolicy.maxAttempts) {
            this.quota.release(reservation);
            await this.usage.append({
              requestId: input.requestId,
              userId: input.userId,
              feature: input.feature,
              providerId: selection.capability.providerId,
              modelId: selection.capability.modelId,
              attempts,
              status: 'FAILED',
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCostUsd: null,
              occurredAt: new Date(),
              errorCode: normalized.code,
            });
            throw normalized;
          }
          await this.delay(this.runtimePolicy.retryDelayMs);
        }
      }
    } catch (error) {
      throw this.normalizeError(error);
    }
    this.quota.release(reservation);
    throw new AiRuntimeError('AI_PROVIDER_ERROR', 'AI provider request failed');
  }

  private validateRequest(
    input: AiCompletionInput,
    capability: AiModelCapability,
  ): void {
    const validMessages = Array.isArray(input?.messages) && input.messages.length > 0 && input.messages.every((message) => {
      if (!message || typeof message !== 'object') return false;
      const candidate = message as { role?: unknown; content?: unknown };
      return (
        (candidate.role === 'system' || candidate.role === 'user' || candidate.role === 'assistant') &&
        typeof candidate.content === 'string' &&
        candidate.content.length <= 100_000
      );
    });
    if (
      typeof input?.requestId !== 'string' ||
      !input.requestId.trim() ||
      typeof input.userId !== 'string' ||
      !input.userId.trim() ||
      typeof input.feature !== 'string' ||
      !input.feature.trim() ||
      !validMessages ||
      !Number.isInteger(input.estimatedInputTokens) ||
      input.estimatedInputTokens < 0 ||
      input.estimatedInputTokens > capability.maxInputTokens ||
      !Number.isInteger(input.maxOutputTokens) ||
      input.maxOutputTokens < 1 ||
      input.maxOutputTokens > capability.maxOutputTokens ||
      (input.structuredOutputKind !== undefined && !AI_STRUCTURED_OUTPUT_KINDS.includes(input.structuredOutputKind))
    ) {
      throw new AiRuntimeError('AI_REQUEST_INVALID', 'AI completion request is invalid');
    }
  }

  private validateRuntimePolicy(): void {
    if (
      !Number.isInteger(this.runtimePolicy.timeoutMs) ||
      this.runtimePolicy.timeoutMs <= 0 ||
      !Number.isInteger(this.runtimePolicy.maxAttempts) ||
      this.runtimePolicy.maxAttempts < 1 ||
      !Number.isInteger(this.runtimePolicy.retryDelayMs) ||
      this.runtimePolicy.retryDelayMs < 0
    ) {
      throw new AiRuntimeError('AI_POLICY_UNAVAILABLE', 'AI runtime policy is invalid');
    }
  }

  private validatePolicy(policy: AiUsagePolicy): void {
    if (
      !policy.quotaKey ||
      !Number.isInteger(policy.maxTokensPerWindow) ||
      policy.maxTokensPerWindow < 0 ||
      !Number.isInteger(policy.quotaWindowMs) ||
      policy.quotaWindowMs <= 0 ||
      !policy.rateLimitKey ||
      !Number.isInteger(policy.maxRequestsPerWindow) ||
      policy.maxRequestsPerWindow < 0 ||
      !Number.isInteger(policy.rateLimitWindowMs) ||
      policy.rateLimitWindowMs <= 0
    ) {
      throw new AiRuntimeError('AI_POLICY_UNAVAILABLE', 'AI usage policy is invalid');
    }
  }

  private validateResult(
    result: AiCompletionResult,
    capability: AiModelCapability,
    maxOutputTokens: number,
    reservedTokens: number,
    structuredOutputKind?: import('./ai.outputs').AiStructuredOutputKind,
  ): void {
    const usage = result?.usage;
    if (
      !result ||
      typeof result.text !== 'string' ||
      !usage ||
      !Number.isInteger(usage.inputTokens) ||
      usage.inputTokens < 0 ||
      !Number.isInteger(usage.outputTokens) ||
      usage.outputTokens < 0 ||
      usage.outputTokens > maxOutputTokens ||
      usage.inputTokens > capability.maxInputTokens ||
      usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
      usage.totalTokens > reservedTokens
    ) {
      throw new AiRuntimeError('AI_INVALID_RESPONSE', 'AI provider returned invalid usage data');
    }
    if (structuredOutputKind !== undefined) {
      parseAiStructuredOutput(structuredOutputKind, result.text);
    }
  }

  private async completeWithTimeout(
    adapter: AiProviderAdapter,
    input: AiCompletionInput,
  ): Promise<AiCompletionResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AiProviderError('TIMEOUT', 'AI provider request timed out', true));
      }, this.runtimePolicy.timeoutMs);
    });
    try {
      return await Promise.race([
        adapter.complete(input, controller.signal),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private isRetryable(error: unknown): boolean {
    return error instanceof AiProviderError && error.retryable;
  }

  private normalizeError(error: unknown): AiRuntimeError {
    if (error instanceof AiRuntimeError) return error;
    if (error instanceof AiContractError) {
      return new AiRuntimeError('AI_INVALID_RESPONSE', 'AI provider returned invalid structured output');
    }
    if (error instanceof AiAvailabilityError) {
      return new AiRuntimeError(error.code, error.message);
    }
    if (error instanceof AiUsagePolicyError) {
      return new AiRuntimeError(error.code, error.message);
    }
    if (error instanceof AiRateLimitError) {
      return new AiRuntimeError(error.code, error.message);
    }
    if (this.isProviderError(error)) {
      return new AiRuntimeError(
        error.code === 'TIMEOUT' ? 'AI_PROVIDER_TIMEOUT' : 'AI_PROVIDER_ERROR',
        'AI provider request failed',
      );
    }
    return new AiRuntimeError('AI_PROVIDER_ERROR', 'AI provider request failed');
  }

  private isProviderError(error: unknown): error is AiProviderError {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      'retryable' in error &&
      ['TIMEOUT', 'RATE_LIMITED', 'TEMPORARY', 'INVALID_RESPONSE', 'UNKNOWN'].includes(
        String(error.code),
      ),
    );
  }

  private async recordRejected(
    input: AiCompletionInput,
    capability: AiModelCapability,
    error: Error & { code?: string },
  ): Promise<void> {
    await this.usage.append({
      requestId: input.requestId,
      userId: input.userId,
      feature: input.feature,
      providerId: capability.providerId,
      modelId: capability.modelId,
      attempts: 0,
      status: 'REJECTED',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: null,
      occurredAt: new Date(),
      errorCode: error.code ?? 'AI_REQUEST_REJECTED',
    });
  }

  private async delay(delayMs: number): Promise<void> {
    if (delayMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}
