import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AiContractError } from './ai.contracts';
import {
  AI_CONVERSATION_MAX_HISTORY_MESSAGES,
  AI_CONVERSATION_MAX_TURN_LENGTH,
  buildAiConversationCompletionInput,
  normalizeAiConversationCreateInput,
  normalizeAiConversationOutput,
} from './ai.conversation.contracts';
import {
  AI_CONVERSATION_REPOSITORY,
  type AiConversationRecord,
  type AiConversationRepository,
  type AiConversationTurn,
} from './ai.conversation.repository';
import { AiConversationFailure, aiConversationFailure } from './ai.conversation.errors';
import { AiRuntimeError, AiRuntimeService } from './ai.runtime';
import { projectLearnerContext, type AiLearnerContext } from './ai.context';
import { PROFILE_REPOSITORY, type ProfileRepository } from '../profile/profile.repository';
import type { CreateAiConversationDto, CreateAiConversationTurnDto, ExplainAiConversationDto } from './ai.conversation.dto';

export interface AiConversationGoalResponse {
  label: string;
  completed: boolean;
}

export interface AiConversationTurnResponse {
  id: string;
  role: 'learner' | 'assistant';
  kind: 'response' | 'explanation';
  content: string;
  createdAt: string;
}

export interface AiConversationResponse {
  id: string;
  mode: 'conversation' | 'roleplay';
  status: 'ACTIVE' | 'ERROR' | 'STOPPED';
  responseLanguageCode: string;
  learnerContext: AiLearnerContext;
  roleplay: AiConversationRecord['roleplay'];
  turns: AiConversationTurnResponse[];
  goals: AiConversationGoalResponse[];
  feedback: { summary: string; preciseScore: null } | null;
  failure: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class AiConversationService {
  constructor(
    @Inject(AI_CONVERSATION_REPOSITORY)
    private readonly conversations: AiConversationRepository,
    @Inject(PROFILE_REPOSITORY)
    private readonly profiles: ProfileRepository,
    private readonly runtime: AiRuntimeService,
  ) {}

  async create(userId: string, input: CreateAiConversationDto): Promise<AiConversationResponse> {
    try {
      const profile = await this.profiles.findProfile(userId);
      const learnerContext = projectLearnerContext(profile, { targetLanguageCode: input.targetLanguageCode });
      const normalized = normalizeAiConversationCreateInput(input, learnerContext);
      const record = await this.conversations.create({
        ownerUserId: userId,
        mode: normalized.mode,
        responseLanguageCode: normalized.responseLanguageCode,
        learnerContext,
        roleplay: normalized.roleplay,
      });
      return this.toResponse(record);
    } catch (error) {
      throw this.normalizeContractError(error);
    }
  }

  async get(userId: string, conversationId: string): Promise<AiConversationResponse> {
    return this.toResponse(await this.requireOwned(userId, conversationId));
  }

  async sendTurn(userId: string, conversationId: string, input: CreateAiConversationTurnDto): Promise<AiConversationResponse> {
    const record = await this.requireOwned(userId, conversationId);
    this.assertCanContinue(record);
    const retry = input.retry === true;
    if (retry && record.status !== 'ERROR') {
      aiConversationFailure('AI_CONVERSATION_RETRY_UNAVAILABLE', 'Retry is only available after a failed AI turn', 409);
    }
    let learnerTurn = retry ? record.turns.filter((turn) => turn.role === 'learner').at(-1) : undefined;
    if (!retry) {
      learnerTurn = {
        id: randomUUID(),
        role: 'learner',
        kind: 'response',
        content: normalizeTurn(input.message),
        createdAt: new Date(),
        requestId: randomUUID(),
      };
      record.turns.push(learnerTurn);
    }
    if (!learnerTurn) aiConversationFailure('AI_CONVERSATION_TURN_INVALID', 'A conversation message is required');
    if (record.status === 'ERROR') record.status = 'ACTIVE';
    const request = buildConversationRequest(record, learnerTurn!, 'response');
    try {
      const result = await this.runtime.complete(request);
      record.turns.push({
        id: randomUUID(),
        role: 'assistant',
        kind: 'response',
        content: normalizeAiConversationOutput(result.text),
        createdAt: new Date(),
        requestId: learnerTurn!.requestId,
      });
      boundStoredTurns(record);
      record.failureCode = null;
      record.failureMessage = null;
      record.updatedAt = new Date();
      await this.conversations.save(record);
      return this.toResponse(record);
    } catch (error) {
      record.status = 'ERROR';
      record.failureCode = readErrorCode(error);
      record.failureMessage = 'AI provider is unavailable. Your message is kept for retry.';
      boundStoredTurns(record);
      record.updatedAt = new Date();
      await this.conversations.save(record);
      throw this.normalizeRuntimeError(error);
    }
  }

  async explain(userId: string, conversationId: string, input: ExplainAiConversationDto): Promise<AiConversationResponse> {
    const record = await this.requireOwned(userId, conversationId);
    this.assertCanContinue(record);
    const target = record.turns.find((turn) => turn.id === input.messageId && turn.role === 'assistant');
    if (!target) aiConversationFailure('AI_CONVERSATION_MESSAGE_NOT_FOUND', 'The conversation message was not found', 404);
    const requestId = randomUUID();
    const request = buildConversationRequest(record, {
      id: randomUUID(),
      role: 'learner',
      kind: 'response',
      content: `Explain this generated response for language practice: ${target!.content}`,
      createdAt: new Date(),
      requestId,
    }, 'explanation');
    try {
      const result = await this.runtime.complete(request);
      record.turns.push({
        id: randomUUID(),
        role: 'assistant',
        kind: 'explanation',
        content: normalizeAiConversationOutput(result.text),
        createdAt: new Date(),
        requestId,
      });
      boundStoredTurns(record);
      record.failureCode = null;
      record.failureMessage = null;
      record.updatedAt = new Date();
      await this.conversations.save(record);
      return this.toResponse(record);
    } catch (error) {
      record.status = 'ERROR';
      record.failureCode = readErrorCode(error);
      record.failureMessage = 'The explanation service is unavailable. Please try again later.';
      boundStoredTurns(record);
      record.updatedAt = new Date();
      await this.conversations.save(record);
      throw this.normalizeRuntimeError(error);
    }
  }

  async stop(userId: string, conversationId: string): Promise<AiConversationResponse> {
    const record = await this.requireOwned(userId, conversationId);
    if (record.status !== 'STOPPED') {
      record.status = 'STOPPED';
      record.failureCode = null;
      record.failureMessage = null;
      record.updatedAt = new Date();
      await this.conversations.save(record);
    }
    return this.toResponse(record);
  }

  private async requireOwned(userId: string, conversationId: string): Promise<AiConversationRecord> {
    const record = await this.conversations.findById(conversationId);
    if (!record || record.ownerUserId !== userId) aiConversationFailure('AI_CONVERSATION_NOT_FOUND', 'The conversation was not found', 404);
    return record!;
  }

  private assertCanContinue(record: AiConversationRecord): void {
    if (record.status === 'STOPPED') aiConversationFailure('AI_CONVERSATION_STOPPED', 'The conversation has ended', 409);
  }

  private toResponse(record: AiConversationRecord): AiConversationResponse {
    const goals = record.roleplay?.goals ?? [];
    return {
      id: record.id,
      mode: record.mode,
      status: record.status,
      responseLanguageCode: record.responseLanguageCode,
      learnerContext: record.learnerContext,
      roleplay: record.roleplay,
      turns: record.turns.map((turn) => ({ id: turn.id, role: turn.role, kind: turn.kind, content: turn.content, createdAt: turn.createdAt.toISOString() })),
      goals: goals.map((label) => ({ label, completed: false })),
      feedback: record.status === 'STOPPED'
        ? { summary: 'Phiên đã kết thúc. Hãy xem lại các lượt thoại và mục tiêu đã chọn; hệ thống không tự chấm điểm chính xác.', preciseScore: null }
        : null,
      failure: record.failureCode && record.failureMessage ? { code: record.failureCode, message: record.failureMessage } : null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private normalizeContractError(error: unknown): AiConversationFailure {
    if (error instanceof AiConversationFailure) return error;
    if (error instanceof AiContractError) return new AiConversationFailure(error.code, 400, 'The conversation request is invalid');
    return new AiConversationFailure('AI_CONVERSATION_UNAVAILABLE', 503, 'The conversation service is unavailable');
  }

  private normalizeRuntimeError(error: unknown): AiConversationFailure {
    if (error instanceof AiConversationFailure) return error;
    if (error instanceof AiRuntimeError) {
      const status = error.code === 'AI_QUOTA_EXCEEDED' || error.code === 'AI_RATE_LIMITED' ? 429 : error.code === 'AI_REQUEST_INVALID' ? 400 : 503;
      const message = error.code === 'AI_PROVIDER_UNAVAILABLE'
        ? 'AI provider is currently offline'
        : error.code === 'AI_QUOTA_EXCEEDED' || error.code === 'AI_RATE_LIMITED'
          ? 'AI practice quota or rate limit has been reached'
          : 'AI conversation could not be completed';
      return new AiConversationFailure(error.code, status, message);
    }
    if (error instanceof AiContractError) return new AiConversationFailure(error.code, 502, 'AI conversation response was invalid');
    return new AiConversationFailure('AI_CONVERSATION_UNAVAILABLE', 503, 'The conversation service is unavailable');
  }
}

function buildConversationRequest(record: AiConversationRecord, currentTurn: AiConversationTurn, kind: 'response' | 'explanation') {
  const history = record.turns.filter((turn) => turn.id !== currentTurn.id).slice(-AI_CONVERSATION_MAX_HISTORY_MESSAGES).map((turn) => ({ role: turn.role, content: turn.content }));
  return buildAiConversationCompletionInput({
    requestId: currentTurn.requestId,
    userId: record.ownerUserId,
    feature: kind === 'explanation' ? 'ai.conversation.explanation' : `ai.${record.mode}`,
    learnerContext: record.learnerContext,
    conversation: { mode: record.mode, responseLanguageCode: record.responseLanguageCode, roleplay: record.roleplay },
    history,
    currentMessage: currentTurn.content,
  });
}

function normalizeTurn(value: unknown): string {
  if (typeof value !== 'string') aiConversationFailure('AI_CONVERSATION_TURN_INVALID', 'A conversation message is required');
  const normalized = (value as string).normalize('NFKC').replace(/\r\n?/g, '\n').trim();
  if (!normalized || normalized.length > AI_CONVERSATION_MAX_TURN_LENGTH || normalized.includes('\u0000')) aiConversationFailure('AI_CONVERSATION_TURN_INVALID', 'The conversation message is invalid');
  return normalized;
}

function readErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return 'AI_CONVERSATION_UNAVAILABLE';
}

function boundStoredTurns(record: AiConversationRecord): void {
  record.turns = record.turns.slice(-AI_CONVERSATION_MAX_HISTORY_MESSAGES);
}
