import { Inject, Injectable } from '@nestjs/common';
import {
  AI_PROVIDER_ADAPTERS,
  type AiModelCapability,
  type AiProviderAdapter,
  type AiProviderState,
  type AiCompletionRequest,
  type AiCompletionResult,
} from './ai.types';

export type AiAvailabilityErrorCode =
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_MODEL_UNAVAILABLE';

export class AiAvailabilityError extends Error {
  readonly name = 'AiAvailabilityError';

  constructor(readonly code: AiAvailabilityErrorCode, message: string) {
    super(message);
  }
}

export interface AiProviderSelection {
  adapter: AiProviderAdapter;
  capability: AiModelCapability;
}

@Injectable()
export class AiProviderRegistry {
  constructor(
    @Inject(AI_PROVIDER_ADAPTERS)
    private readonly adapters: readonly AiProviderAdapter[],
  ) {}

  resolve(modelId: string): AiProviderSelection {
    const matching = this.adapters.find((adapter) => (
      adapter.capabilities.some((capability) => capability.modelId === modelId)
    ));
    if (matching) {
      if (matching.state !== 'available') {
        throw new AiAvailabilityError(
          'AI_PROVIDER_UNAVAILABLE',
          `AI provider ${matching.providerId} is ${matching.state}`,
        );
      }
      const capability = matching.capabilities.find((item) => item.modelId === modelId);
      if (capability) return { adapter: matching, capability };
    }

    const unavailable = this.adapters.find((adapter) => adapter.state !== 'available');
    if (unavailable) {
      throw new AiAvailabilityError(
        'AI_PROVIDER_UNAVAILABLE',
        `AI provider ${unavailable.providerId} is ${unavailable.state}`,
      );
    }
    throw new AiAvailabilityError(
      'AI_MODEL_UNAVAILABLE',
      `AI model ${modelId} is not available`,
    );
  }

  listCapabilities(): readonly AiModelCapability[] {
    return this.adapters
      .filter((adapter) => adapter.state === 'available')
      .flatMap((adapter) => adapter.capabilities);
  }
}

export class FailClosedAiProviderAdapter implements AiProviderAdapter {
  readonly capabilities: readonly AiModelCapability[] = [];

  constructor(
    readonly providerId: string,
    readonly state: Extract<AiProviderState, 'disabled' | 'misconfigured'>,
    private readonly reason: string,
  ) {}

  async complete(
    _request: AiCompletionRequest,
    _signal: AbortSignal,
  ): Promise<AiCompletionResult> {
    throw new AiAvailabilityError('AI_PROVIDER_UNAVAILABLE', this.reason);
  }
}
