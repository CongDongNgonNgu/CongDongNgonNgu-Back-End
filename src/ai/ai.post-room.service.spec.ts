import { describe, expect, it, jest } from '@jest/globals';
import { AiRuntimeError } from './ai.runtime';
import { AiPostRoomFailure } from './ai.post-room.errors';
import {
  AiPostRoomService,
  DisabledAiPostRoomExecutor,
} from './ai.post-room.service';
import { AI_POST_ROOM_CONSENT_POLICY_VERSION, AI_POST_ROOM_CONTRACT_VERSION, AI_POST_ROOM_SOURCE_VERSION } from './ai.post-room.contracts';

const input = {
  actorUserId: 'user-13e-001',
  roomId: 'room-13e-001',
  participantId: 'participant-13e-001',
  source: {
    version: AI_POST_ROOM_SOURCE_VERSION,
    artifactId: 'artifact-13e-001',
    roomId: 'room-13e-001',
    participantId: 'participant-13e-001',
    ownerUserId: 'user-13e-001',
    kind: 'CONSENTED_TEXT_ARTIFACT' as const,
    partyCount: 1 as const,
    content: 'A bounded fake source fixture.',
    capturedAt: '2026-10-01T11:55:00.000Z',
  },
  consent: {
    version: AI_POST_ROOM_CONTRACT_VERSION,
    id: 'consent-13e-001',
    actorUserId: 'user-13e-001',
    roomId: 'room-13e-001',
    participantId: 'participant-13e-001',
    sourceArtifactId: 'artifact-13e-001',
    purpose: 'POST_ROOM_AI_FEEDBACK' as const,
    policyVersion: AI_POST_ROOM_CONSENT_POLICY_VERSION,
    grantedAt: '2026-10-01T11:56:00.000Z',
    revokedAt: null,
  },
  now: new Date('2026-10-01T12:00:00.000Z'),
};

const feedback = JSON.stringify({
  version: 'ai.post-room.result.v1',
  kind: 'POST_ROOM_AI_FEEDBACK',
  summary: 'Safe fixture feedback.',
  vocabularySuggestions: [],
  grammarObservations: [],
  practiceSuggestions: ['Repeat the dialogue.'],
});

describe('AiPostRoomService', () => {
  it('returns a bounded result from a fake runtime without exposing provider metadata or source', async () => {
    const execute = jest.fn(async () => ({
      text: feedback,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      finishReason: 'stop' as const,
      providerId: 'fake-provider',
      modelId: 'fake-model',
      attempts: 1,
      estimatedCostUsd: null,
    }));
    const service = new AiPostRoomService({ execute } as never);

    const result = await service.request(input);

    expect(result).toEqual({
      contractVersion: 'ai.post-room.v1',
      requestId: expect.stringMatching(/^post-room:[a-f0-9]{64}$/),
      status: 'COMPLETED',
      feedback: expect.objectContaining({ kind: 'POST_ROOM_AI_FEEDBACK' }),
    });
    expect(JSON.stringify(result)).not.toContain('fake-provider');
    expect(JSON.stringify(result)).not.toContain('room-13e-001');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the Phase 13E executor is disabled', async () => {
    const service = new AiPostRoomService(new DisabledAiPostRoomExecutor());

    await expect(service.request(input)).rejects.toMatchObject({
      code: 'AI_POST_ROOM_DISABLED',
      message: 'Post-room AI feedback is currently unavailable',
    });
  });

  it('sanitizes a provider-neutral runtime failure from a future executor', async () => {
    const execute = jest.fn(async () => {
      throw new AiRuntimeError('AI_PROVIDER_UNAVAILABLE', 'provider secret details');
    });
    const service = new AiPostRoomService({ execute } as never);

    await expect(service.request(input)).rejects.toMatchObject({
      code: 'AI_PROVIDER_UNAVAILABLE',
      message: 'Post-room AI feedback is currently unavailable',
    });
    await expect(service.request(input)).rejects.not.toThrow('provider secret details');
  });

  it('rejects revoked consent before reaching the runtime', async () => {
    const execute = jest.fn();
    const service = new AiPostRoomService({ execute } as never);
    const revoked = {
      ...input,
      consent: { ...input.consent, revokedAt: '2026-10-01T12:00:00.000Z' },
    };

    await expect(service.request(revoked)).rejects.toBeInstanceOf(AiPostRoomFailure);
    expect(execute).not.toHaveBeenCalled();
  });
});
