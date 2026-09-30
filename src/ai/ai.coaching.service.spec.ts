import { describe, expect, it } from '@jest/globals';
import type { ProfileRecord } from '../profile/profile.types';
import { AiCoachingFailure } from './ai.coaching.errors';
import { AiCoachingService } from './ai.coaching.service';
import type { AiCompletionResponse } from './ai.types';

const profile: ProfileRecord = {
  languages: [{
    language: {
      id: 'catalog-id',
      code: 'en',
      slug: 'english',
      nativeName: 'English',
      englishName: 'English',
      vietnameseName: 'Tiếng Anh',
      direction: 'ltr',
      active: true,
      launch: true,
      sortOrder: 1,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    roles: ['learning'],
    declaredProficiency: 'A2',
    assessedProficiency: 'B1',
    isPrimaryLearningTarget: true,
    visibility: 'PRIVATE',
  }],
  goals: ['writing'],
  skills: ['writing', 'grammar'],
  interests: ['travel'],
  timezone: 'Asia/Ho_Chi_Minh',
  availability: [],
};

function providerResponse(text: string): AiCompletionResponse {
  return {
    text,
    usage: { inputTokens: 20, outputTokens: 25, totalTokens: 45 },
    finishReason: 'stop',
    providerId: 'deterministic-test-provider',
    modelId: 'coaching-default',
    attempts: 1,
    estimatedCostUsd: null,
  };
}

function buildService(runtime: { complete: (input: unknown) => Promise<AiCompletionResponse> }) {
  return new AiCoachingService(
    { findProfile: async () => profile } as never,
    runtime as never,
  );
}

describe('AiCoachingService', () => {
  it('returns a typed writing result without persisting or replacing the original submission', async () => {
    const service = buildService({
      complete: async () => providerResponse(JSON.stringify({
        version: 'ai.output.v1',
        kind: 'WRITING_CORRECTION',
        summary: 'Clear writing.',
        corrections: [{
          originalText: 'I has a book.',
          correctedText: 'I have a book.',
          explanation: 'The subject requires have.',
          naturalAlternative: 'I own a book.',
        }],
      })),
    });

    const result = await service.write('user-09d', {
      targetLanguageCode: 'en',
      text: 'I has a book.',
    });

    expect(result).toMatchObject({
      contractVersion: 'ai.coaching.v1',
      mode: 'writing_coach',
      originalText: 'I has a book.',
      learnerContext: {
        targetLanguage: { code: 'en' },
        proficiency: { effective: 'B1' },
      },
      output: { kind: 'WRITING_CORRECTION' },
    });
  });

  it('returns grammar explanation and focused practice from validated structured output', async () => {
    const service = buildService({
      complete: async () => providerResponse(JSON.stringify({
        version: 'ai.output.v1',
        kind: 'GRAMMAR_COACHING',
        explanation: 'Use the past form for yesterday.',
        examples: [{
          incorrectText: 'I go yesterday.',
          correctedText: 'I went yesterday.',
          explanation: 'Went is the past form.',
        }],
        practiceItems: [{
          prompt: 'I ___ yesterday.',
          answer: 'went',
          explanation: 'Went is the past form of go.',
        }],
      })),
    });

    const result = await service.grammar('user-09d', {
      targetLanguageCode: 'en',
      explanationLanguage: 'VIETNAMESE',
      text: 'I go yesterday.',
    });

    expect(result.output).toMatchObject({ kind: 'GRAMMAR_COACHING' });
    expect(result.output.practiceItems).toHaveLength(1);
    expect(result.originalText).toBe('I go yesterday.');
  });

  it('fails closed when a provider returns malformed coaching output', async () => {
    const service = buildService({
      complete: async () => providerResponse('{"kind":"WRITING_CORRECTION"}'),
    });

    try {
      await service.write('user-09d', { text: 'I has a book.' });
      throw new Error('Expected malformed output to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AiCoachingFailure);
      expect(error).toMatchObject({ code: 'AI_STRUCTURED_OUTPUT_INVALID' });
      expect((error as AiCoachingFailure).getStatus()).toBe(502);
    }
  });
});
