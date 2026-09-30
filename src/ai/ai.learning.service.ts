import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AiContractError } from './ai.contracts';
import {
  AI_LEARNING_CONTRACT_VERSION,
  buildAiLearningCompletionInput,
  normalizeAiLearningRequest,
  projectAiLearningSource,
  type AiLearningResponse,
} from './ai.learning.contracts';
import { AiLearningFailure } from './ai.learning.errors';
import { projectLearnerContext } from './ai.context';
import { parseAiStructuredOutput } from './ai.outputs';
import { AiRuntimeError, AiRuntimeService } from './ai.runtime';
import { PROFILE_REPOSITORY, type ProfileRepository } from '../profile/profile.repository';
import { LibraryService } from '../library/library.service';
import type { AiLearningDto } from './ai.learning.dto';

@Injectable()
export class AiLearningService {
  constructor(
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    private readonly library: LibraryService,
    private readonly runtime: AiRuntimeService,
  ) {}

  async learn(userId: string, input: AiLearningDto): Promise<AiLearningResponse> {
    try {
      const learnerContext = projectLearnerContext(
        await this.profiles.findProfile(userId),
        { targetLanguageCode: input.targetLanguageCode },
      );
      const request = normalizeAiLearningRequest(input, learnerContext);
      const resource = await this.library.getPublicResource(request.resourceId);
      if (!resource) {
        throw new AiContractError(
          'AI_LEARNING_SOURCE_UNAVAILABLE',
          'The library source is not eligible for learning',
        );
      }
      const source = projectAiLearningSource(resource, learnerContext);
      const result = await this.runtime.complete(buildAiLearningCompletionInput({
        requestId: randomUUID(),
        userId,
        learnerContext,
        request,
        source,
      }));
      const output = parseAiStructuredOutput('LEARN_FROM_CONTENT', result.text);
      if (output.kind !== 'LEARN_FROM_CONTENT') {
        throw new AiContractError('AI_STRUCTURED_OUTPUT_INVALID', 'AI structured output is invalid');
      }

      return {
        contractVersion: AI_LEARNING_CONTRACT_VERSION,
        mode: 'learn_from_content',
        source: 'AI_GENERATED',
        learnerContext,
        sourceResource: {
          id: source.resourceId,
          resourceType: source.resourceType,
          primaryLanguageCode: source.primaryLanguageCode,
          secondaryLanguageCode: source.secondaryLanguageCode,
          cefrLevel: source.cefrLevel,
          topics: [...source.topics],
          provenance: source.provenance.map(({ sourceId: _sourceId, ...entry }) => entry),
        },
        output,
      };
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private normalizeError(error: unknown): AiLearningFailure {
    if (error instanceof AiLearningFailure) return error;
    if (error instanceof AiContractError) {
      const status = error.code === 'AI_LEARNING_SOURCE_UNAVAILABLE' ? 404
        : error.code === 'AI_LEARNING_PROVENANCE_INVALID' ? 422
          : error.code === 'AI_STRUCTURED_OUTPUT_INVALID' ? 502
            : 400;
      const message = error.code === 'AI_LEARNING_SOURCE_UNAVAILABLE'
        ? 'This library resource is not eligible for learning'
        : error.code === 'AI_LEARNING_PROVENANCE_INVALID'
          ? 'This library resource has incomplete provenance or licensing'
          : error.code === 'AI_STRUCTURED_OUTPUT_INVALID'
            ? 'AI learning material was invalid'
            : 'The AI learning request is invalid';
      return new AiLearningFailure(error.code, status, message);
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
            ? 'AI learning material was invalid'
            : 'AI learning could not be completed';
      return new AiLearningFailure(error.code, status, message);
    }
    return new AiLearningFailure('AI_LEARNING_UNAVAILABLE', 503, 'The AI learning service is unavailable');
  }
}
