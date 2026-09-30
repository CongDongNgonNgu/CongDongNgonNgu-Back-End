import { describe, expect, it } from '@jest/globals';
import {
  AiAvailabilityError,
  AiProviderRegistry,
  FailClosedAiProviderAdapter,
} from './ai.provider';
import type { AiProviderAdapter } from './ai.types';

const adapter: AiProviderAdapter = {
  providerId: 'test-provider',
  state: 'available',
  capabilities: [{
    providerId: 'test-provider',
    modelId: 'streaming-model',
    supportsStreaming: true,
    maxInputTokens: 2_000,
    maxOutputTokens: 1_000,
    inputCostPerMillionUsd: null,
    outputCostPerMillionUsd: null,
  }],
  async complete() {
    return {
      text: 'test',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    };
  },
};

describe('AiProviderRegistry', () => {
  it('exposes only available model capabilities and preserves streaming metadata', () => {
    const registry = new AiProviderRegistry([adapter]);

    expect(registry.listCapabilities()).toEqual(adapter.capabilities);
    expect(registry.resolve('streaming-model').capability.supportsStreaming).toBe(true);
  });

  it('fails closed for a disabled provider instead of selecting a model', () => {
    const registry = new AiProviderRegistry([
      new FailClosedAiProviderAdapter('disabled', 'disabled', 'AI provider is disabled'),
    ]);

    expect(() => registry.resolve('any-model')).toThrow(AiAvailabilityError);
    expect(() => registry.resolve('any-model')).toThrow('AI provider disabled is disabled');
  });

  it('reports a missing model when all registered providers are available', () => {
    const registry = new AiProviderRegistry([adapter]);

    expect(() => registry.resolve('missing-model')).toThrow('AI model missing-model is not available');
  });
});
