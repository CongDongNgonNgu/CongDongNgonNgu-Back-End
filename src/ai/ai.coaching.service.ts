import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AiContractError } from './ai.contracts';
import {
  buildAiGrammarCoachCompletionInput,
  buildAiWritingCoachCompletionInput,
  normalizeAiGrammarCoachRequest,
  normalizeAiWritingCoachRequest,
  type AiGrammarCoachResponse,
  type AiWritingCoachResponse,
} from './ai.coaching.contracts';
import { AiCoachingFailure } from './ai.coaching.errors';
import { projectLearnerContext } from './ai.context';
import { parseAiStructuredOutput } from './ai.outputs';
import { AiRuntimeError, AiRuntimeService } from './ai.runtime';
import { PROFILE_REPOSITORY, type ProfileRepository } from '../profile/profile.repository';
import type { AiGrammarCoachDto, AiWritingCoachDto } from './ai.coaching.dto';

@Injectable()
export class AiCoachingService {
  constructor(
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    private readonly runtime: AiRuntimeService,
  ) {}

  async write(userId: string, input: AiWritingCoachDto): Promise<AiWritingCoachResponse> {
    try {
      const learnerContext = projectLearnerContext(
        await this.profiles.findProfile(userId),
        { targetLanguageCode: input.targetLanguageCode },
      );
      const request = normalizeAiWritingCoachRequest(input, learnerContext);
      const result = await this.runtime.complete(buildAiWritingCoachCompletionInput({
        requestId: randomUUID(),
        userId,
        learnerContext,
        request,
      }));
      const output = parseAiStructuredOutput('WRITING_CORRECTION', result.text);
      if (output.kind !== 'WRITING_CORRECTION') throw new AiContractError('AI_STRUCTURED_OUTPUT_INVALID', 'AI structured output is invalid');
      return {
        contractVersion: 'ai.coaching.v1',
        mode: 'writing_coach',
        source: 'AI_GENERATED',
        originalText: request.text,
        learnerContext,
        output,
      };
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  async grammar(userId: string, input: AiGrammarCoachDto): Promise<AiGrammarCoachResponse> {
    try {
      const learnerContext = projectLearnerContext(
        await this.profiles.findProfile(userId),
        { targetLanguageCode: input.targetLanguageCode },
      );
      const request = normalizeAiGrammarCoachRequest(input, learnerContext);
      const result = await this.runtime.complete(buildAiGrammarCoachCompletionInput({
        requestId: randomUUID(),
        userId,
        learnerContext,
        request,
      }));
      const output = parseAiStructuredOutput('GRAMMAR_COACHING', result.text);
      if (output.kind !== 'GRAMMAR_COACHING') throw new AiContractError('AI_STRUCTURED_OUTPUT_INVALID', 'AI structured output is invalid');
      return {
        contractVersion: 'ai.coaching.v1',
        mode: 'grammar_coach',
        source: 'AI_GENERATED',
        originalText: request.text,
        learnerContext,
        output,
      };
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private normalizeError(error: unknown): AiCoachingFailure {
    if (error instanceof AiCoachingFailure) return error;
    if (error instanceof AiContractError) {
      const invalidOutput = error.code === 'AI_STRUCTURED_OUTPUT_INVALID';
      return new AiCoachingFailure(
        error.code,
        invalidOutput ? 502 : 400,
        invalidOutput ? 'AI coaching response was invalid' : 'The AI coaching request is invalid',
      );
    }
    if (error instanceof AiRuntimeError) {
      const status = error.code === 'AI_QUOTA_EXCEEDED' || error.code === 'AI_RATE_LIMITED'
        ? 429
        : error.code === 'AI_REQUEST_INVALID'
          ? 400
          : error.code === 'AI_INVALID_RESPONSE'
            ? 502
            : 503;
      const message = error.code === 'AI_PROVIDER_UNAVAILABLE'
        ? 'AI provider is currently offline'
        : error.code === 'AI_QUOTA_EXCEEDED' || error.code === 'AI_RATE_LIMITED'
          ? 'AI practice quota or rate limit has been reached'
          : error.code === 'AI_INVALID_RESPONSE'
            ? 'AI coaching response was invalid'
            : 'AI coaching could not be completed';
      return new AiCoachingFailure(error.code, status, message);
    }
    return new AiCoachingFailure('AI_COACHING_UNAVAILABLE', 503, 'The AI coaching service is unavailable');
  }
}
