import { describe, expect, it, jest } from '@jest/globals';
import type { ProfileRecord } from '../profile/profile.types';
import { AI_LEARNER_CONTEXT_VERSION } from './ai.context';
import { AiLearningFailure } from './ai.learning.errors';
import { AiLearningService } from './ai.learning.service';
import { AiRuntimeError } from './ai.runtime';
import type { AiCompletionResponse } from './ai.types';
import type { LibraryPublicResource } from '../library/library.types';

const profile: ProfileRecord = {
  languages: [{
    language: {
      id: 'catalog-id', code: 'en', slug: 'english', nativeName: 'English', englishName: 'English', vietnameseName: 'Tiếng Anh',
      direction: 'ltr', active: true, launch: true, sortOrder: 1, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    },
    roles: ['learning'], declaredProficiency: 'A2', assessedProficiency: 'B1', isPrimaryLearningTarget: true, visibility: 'PRIVATE',
  }],
  goals: ['conversation'], skills: ['speaking'], interests: ['travel'], timezone: 'Asia/Ho_Chi_Minh', availability: [],
};

function providerResponse(text: string): AiCompletionResponse {
  return {
    text,
    usage: { inputTokens: 20, outputTokens: 50, totalTokens: 70 },
    finishReason: 'stop', providerId: 'deterministic-test-provider', modelId: 'learning-default', attempts: 1, estimatedCostUsd: null,
  };
}

function validOutput(): string {
  return JSON.stringify({
    version: 'ai.output.v1', kind: 'LEARN_FROM_CONTENT', summary: 'Practice this resource.',
    vocabulary: [{ term: 'welcome', meaning: 'a greeting', exampleSentence: 'Welcome to the class.' }],
    grammarNotes: [{ title: 'Present simple', explanation: 'Use it for routines.', example: 'I study every day.' }],
    questions: [{ question: 'What is the main idea?', answerGuide: 'Mention the daily routine.' }],
    miniQuiz: [{ question: 'Choose the greeting.', options: ['Welcome', 'Goodbye'], correctOptionIndex: 0, explanation: 'Welcome is a greeting.' }],
    speakingPrompts: [{ prompt: 'Describe your routine.', followUp: 'Add one time expression.' }],
  });
}

function resourceFixture(overrides: Partial<LibraryPublicResource> = {}): LibraryPublicResource {
  return {
    id: 'resource-09e', resourceType: 'SENTENCE', primaryLanguageCode: 'en', secondaryLanguageCode: null, cefrLevel: 'A2', topics: ['daily-life'], reviewState: 'VERIFIED',
    details: { resourceType: 'SENTENCE', text: 'A safe public sentence.', context: 'Practice' },
    provenance: [{ sourceType: 'COMMUNITY_POST', sourceId: 'public-post-09e', sourceUrl: 'https://example.com/source', originalAuthorReference: null, attribution: 'Community author', license: { licenseKey: 'CC-BY-4.0', displayName: 'CC BY 4.0', canonicalUrl: 'https://creativecommons.org/licenses/by/4.0/', attributionRequired: true, redistributionAllowed: true, derivativeConstraints: null } }],
    createdAt: new Date('2026-09-30T00:00:00.000Z'), updatedAt: new Date('2026-09-30T00:00:00.000Z'), ...overrides,
  };
}

function buildService(
  resource: LibraryPublicResource | null,
  runtime: { complete: (input: unknown) => Promise<AiCompletionResponse> },
) {
  const getPublicResource = jest.fn(async (_resourceId: string) => resource);
  return {
    service: new AiLearningService(
      { findProfile: async () => profile } as never,
      { getPublicResource } as never,
      runtime as never,
    ),
    getPublicResource,
  };
}

describe('AiLearningService', () => {
  it('uses the public Library projection and returns attribution without persistence', async () => {
    const resource = resourceFixture() as LibraryPublicResource & { createdByUserId?: string; privateNote?: string };
    resource.createdByUserId = 'owner-secret';
    resource.privateNote = 'moderation-secret';
    const before = JSON.stringify(resource);
    const { service, getPublicResource } = buildService(resource, { complete: async () => providerResponse(validOutput()) });

    const result = await service.learn('user-09e', { resourceId: 'resource-09e' });

    expect(getPublicResource).toHaveBeenCalledWith('resource-09e');
    expect(result).toMatchObject({
      contractVersion: 'ai.learning.v1', mode: 'learn_from_content', source: 'AI_GENERATED',
      learnerContext: { version: AI_LEARNER_CONTEXT_VERSION, targetLanguage: { code: 'en' } },
      sourceResource: { id: 'resource-09e', provenance: [{ attribution: 'Community author' }] },
      output: { kind: 'LEARN_FROM_CONTENT' },
    });
    expect(JSON.stringify(result)).not.toContain('owner-secret');
    expect(JSON.stringify(result)).not.toContain('moderation-secret');
    expect(JSON.stringify(resource)).toBe(before);
  });

  it('fails closed for ineligible, malformed and provenance-invalid sources', async () => {
    const ineligible = buildService(null, { complete: async () => providerResponse(validOutput()) });
    await expect(ineligible.service.learn('user-09e', { resourceId: 'resource-09e' }))
      .rejects.toMatchObject({ code: 'AI_LEARNING_SOURCE_UNAVAILABLE' });

    const malformedResource = { ...resourceFixture(), reviewState: 'DRAFT' } as unknown as LibraryPublicResource;
    const malformedSource = buildService(malformedResource, { complete: async () => providerResponse(validOutput()) });
    await expect(malformedSource.service.learn('user-09e', { resourceId: 'resource-09e' }))
      .rejects.toMatchObject({ code: 'AI_LEARNING_SOURCE_UNAVAILABLE' });

    const invalidProvenance = buildService(resourceFixture({ provenance: [] }), { complete: async () => providerResponse(validOutput()) });
    await expect(invalidProvenance.service.learn('user-09e', { resourceId: 'resource-09e' }))
      .rejects.toMatchObject({ code: 'AI_LEARNING_PROVENANCE_INVALID' });
  });

  it('fails closed on malformed output and maps quota/provider failures', async () => {
    const malformed = buildService(resourceFixture(), { complete: async () => providerResponse('{"kind":"LEARN_FROM_CONTENT"}') });
    await expect(malformed.service.learn('user-09e', { resourceId: 'resource-09e' }))
      .rejects.toMatchObject({ code: 'AI_STRUCTURED_OUTPUT_INVALID' });

    const quota = buildService(resourceFixture(), { complete: async () => { throw new AiRuntimeError('AI_QUOTA_EXCEEDED', 'quota'); } });
    await expect(quota.service.learn('user-09e', { resourceId: 'resource-09e' }))
      .rejects.toMatchObject({ code: 'AI_QUOTA_EXCEEDED' });
    await expect(quota.service.learn('user-09e', { resourceId: 'resource-09e' }))
      .rejects.toBeInstanceOf(AiLearningFailure);

    const provider = buildService(resourceFixture(), { complete: async () => { throw new AiRuntimeError('AI_PROVIDER_UNAVAILABLE', 'offline'); } });
    await expect(provider.service.learn('user-09e', { resourceId: 'resource-09e' }))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
  });
});
