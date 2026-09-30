export const AI_PROVIDER_ADAPTERS = 'AI_PROVIDER_ADAPTERS';
export const AI_USAGE_LEDGER = 'AI_USAGE_LEDGER';
export const AI_USAGE_POLICY_RESOLVER = 'AI_USAGE_POLICY_RESOLVER';
export const AI_QUOTA_LEDGER = 'AI_QUOTA_LEDGER';
export const AI_RATE_LIMITER = 'AI_RATE_LIMITER';
export const AI_RUNTIME_POLICY = 'AI_RUNTIME_POLICY';

export type AiProviderState = 'available' | 'disabled' | 'misconfigured';

export type AiMessageRole = 'system' | 'user' | 'assistant';

export interface AiMessage {
  role: AiMessageRole;
  content: string;
}

export interface AiModelCapability {
  providerId: string;
  modelId: string;
  supportsStreaming: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  inputCostPerMillionUsd: number | null;
  outputCostPerMillionUsd: number | null;
}

export interface AiCompletionRequest {
  requestId: string;
  modelId: string;
  messages: readonly AiMessage[];
  estimatedInputTokens: number;
  maxOutputTokens: number;
  temperature?: number;
}

export type AiFinishReason = 'stop' | 'length' | 'content_filter' | 'unknown';

export interface AiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiCompletionResult {
  text: string;
  usage: AiTokenUsage;
  finishReason: AiFinishReason;
}

export interface AiStreamChunk {
  textDelta: string;
  done: boolean;
  usage?: AiTokenUsage;
  finishReason?: AiFinishReason;
}

export type AiProviderErrorCode =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'TEMPORARY'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN';

export class AiProviderError extends Error {
  readonly name = 'AiProviderError';

  constructor(
    readonly code: AiProviderErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface AiProviderAdapter {
  readonly providerId: string;
  readonly state: AiProviderState;
  readonly capabilities: readonly AiModelCapability[];
  complete(request: AiCompletionRequest, signal: AbortSignal): Promise<AiCompletionResult>;
  stream?(
    request: AiCompletionRequest,
    signal: AbortSignal,
  ): AsyncIterable<AiStreamChunk>;
}

export interface AiUsagePolicy {
  quotaKey: string;
  maxTokensPerWindow: number;
  quotaWindowMs: number;
  rateLimitKey: string;
  maxRequestsPerWindow: number;
  rateLimitWindowMs: number;
}

export interface AiUsagePolicyResolver {
  resolve(input: { userId: string; entitlementKey?: string }): Promise<AiUsagePolicy | null>;
}

export interface AiQuotaReservation {
  id: string;
  quotaKey: string;
  windowStartedAt: number;
  reservedTokens: number;
}

export interface AiQuotaLedger {
  reserve(input: {
    quotaKey: string;
    requestedTokens: number;
    maxTokensPerWindow: number;
    windowMs: number;
    now?: number;
  }): AiQuotaReservation;
  settle(reservation: AiQuotaReservation, actualTokens: number): void;
  release(reservation: AiQuotaReservation): void;
}

export interface AiRateLimiter {
  consume(key: string, limit: number, windowMs: number, now?: number): boolean;
}

export interface AiUsageRecord {
  requestId: string;
  userId: string;
  feature: string;
  providerId: string;
  modelId: string;
  attempts: number;
  status: 'SUCCEEDED' | 'FAILED' | 'REJECTED';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  occurredAt: Date;
  errorCode?: string;
}

export interface AiUsageLedger {
  append(record: AiUsageRecord): Promise<void>;
}

export interface AiRuntimePolicy {
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
}

export interface AiCompletionInput extends AiCompletionRequest {
  userId: string;
  feature: string;
  entitlementKey?: string;
}

export interface AiCompletionResponse extends AiCompletionResult {
  providerId: string;
  modelId: string;
  attempts: number;
  estimatedCostUsd: number | null;
}
