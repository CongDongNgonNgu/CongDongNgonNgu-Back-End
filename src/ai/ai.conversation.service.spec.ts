import { describe, expect, it, jest } from '@jest/globals';
import { AiRuntimeError } from './ai.runtime';
import { AI_ROLEPLAY_SCENARIOS } from './ai.conversation.contracts';
import { InMemoryAiConversationRepository } from './ai.conversation.repository';
import { AiConversationFailure } from './ai.conversation.errors';
import { AiConversationService } from './ai.conversation.service';

const profile = {
  languages: [{
    language: { code: 'ja', englishName: 'Japanese', active: true },
    roles: ['learning'],
    declaredProficiency: 'B1',
    assessedProficiency: null,
    isPrimaryLearningTarget: true,
    visibility: 'PRIVATE',
  }],
  goals: ['speaking'],
  skills: [],
  interests: [],
  timezone: null,
  availability: [],
};

function createService(runtime: { complete: jest.Mock }) {
  return new AiConversationService(
    new InMemoryAiConversationRepository(),
    { findProfile: jest.fn().mockResolvedValue(profile as never) } as never,
    runtime as never,
  );
}

function validConversation() {
  return { mode: 'conversation' };
}

function validRoleplay() {
  const scenario = AI_ROLEPLAY_SCENARIOS[0];
  return {
    mode: 'roleplay',
    roleplay: {
      scenarioId: scenario.id,
      context: scenario.context,
      learnerRole: scenario.learnerRole,
      assistantRole: scenario.assistantRole,
      targetLanguageCode: 'ja',
      proficiency: 'B1',
      objective: scenario.objective,
      tone: 'Lịch sự',
      responseStyle: 'Ngắn gọn',
      constraints: ['Không nhận là người thật'],
      safeBoundaries: scenario.safeBoundaries,
      goals: scenario.goals,
    },
  };
}

function successResult(text = '続けて練習しましょう。') {
  return { text, usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 }, finishReason: 'stop' as const };
}

describe('AiConversationService', () => {
  it('creates a roleplay session and keeps all initial scenarios on one reusable path', async () => {
    const runtime = { complete: jest.fn() };
    const service = createService(runtime);

    for (const scenario of AI_ROLEPLAY_SCENARIOS) {
      const response = await service.create('user-09c', {
        mode: 'roleplay',
        roleplay: {
          ...validRoleplay().roleplay,
          scenarioId: scenario.id,
          context: scenario.context,
          learnerRole: scenario.learnerRole,
          assistantRole: scenario.assistantRole,
          objective: scenario.objective,
          safeBoundaries: scenario.safeBoundaries,
          goals: scenario.goals,
        },
      } as never);
      expect(response.mode).toBe('roleplay');
      expect(response.roleplay?.scenarioId).toBe(scenario.id);
    }
  });

  it('does not expose a session to another owner', async () => {
    const service = createService({ complete: jest.fn() });
    const created = await service.create('owner-a', validConversation() as never);

    await expect(service.get('owner-b', created.id)).rejects.toMatchObject({
      code: 'AI_CONVERSATION_NOT_FOUND',
      status: 404,
    });
  });

  it('links a stable request id to retry and does not duplicate the learner turn', async () => {
    const complete = jest.fn() as jest.Mock;
    complete.mockRejectedValueOnce(new AiRuntimeError('AI_PROVIDER_UNAVAILABLE', 'offline') as never);
    complete.mockResolvedValueOnce(successResult() as never);
    const runtime = { complete };
    const service = createService(runtime);
    const created = await service.create('owner-a', validConversation() as never);

    await expect(service.sendTurn(created.id ? 'owner-a' : 'owner-b', created.id, { message: 'Xin chào' })).rejects.toBeInstanceOf(AiConversationFailure);
    const afterRetry = await service.sendTurn('owner-a', created.id, { retry: true });

    expect(afterRetry.status).toBe('ACTIVE');
    expect(afterRetry.turns.filter((turn) => turn.role === 'learner')).toHaveLength(1);
    expect(runtime.complete).toHaveBeenNthCalledWith(2, expect.objectContaining({ requestId: expect.any(String) }));
    const firstRequest = runtime.complete.mock.calls[0][0] as { requestId: string };
    const secondRequest = runtime.complete.mock.calls[1][0] as { requestId: string };
    expect(firstRequest.requestId).toBe(secondRequest.requestId);
  });

  it('returns an honest post-session feedback state without a fake precise score', async () => {
    const service = createService({ complete: jest.fn() });
    const created = await service.create('owner-a', validRoleplay() as never);
    const stopped = await service.stop('owner-a', created.id);

    expect(stopped.status).toBe('STOPPED');
    expect(stopped.feedback?.preciseScore).toBeNull();
    await expect(service.sendTurn('owner-a', created.id, { message: 'Không gửi được nữa' })).rejects.toMatchObject({
      code: 'AI_CONVERSATION_STOPPED',
      status: 409,
    });
  });
});
