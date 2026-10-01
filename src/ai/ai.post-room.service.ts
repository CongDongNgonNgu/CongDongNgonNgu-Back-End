import { Inject, Injectable } from '@nestjs/common';
import { AiContractError } from './ai.contracts';
import {
  authorizeAiPostRoomRequest,
  projectAiPostRoomResponse,
  type AiPostRoomAuthorizedRequest,
  type AiPostRoomAuthorizationInput,
  type AiPostRoomResponse,
} from './ai.post-room.contracts';
import { AiPostRoomFailure } from './ai.post-room.errors';
import { AiRuntimeError } from './ai.runtime';
import type { AiCompletionResponse } from './ai.types';

export const AI_POST_ROOM_EXECUTOR = 'AI_POST_ROOM_EXECUTOR';

/**
 * An enabled executor must atomically claim the logical request ID and replay
 * the same result for an exact retry. The default Phase 13E executor is
 * deliberately disabled because no task-authorized durable request/result
 * store exists yet.
 */
export interface AiPostRoomExecutor {
  execute(request: AiPostRoomAuthorizedRequest): Promise<AiCompletionResponse>;
}

export class DisabledAiPostRoomExecutor implements AiPostRoomExecutor {
  async execute(_request: AiPostRoomAuthorizedRequest): Promise<AiCompletionResponse> {
    throw new AiPostRoomFailure(
      'AI_POST_ROOM_DISABLED',
      503,
      'Post-room AI feedback is currently unavailable',
    );
  }
}

/**
 * Contract-only service for a future consented post-room source.
 * There is intentionally no controller or persistence in Phase 13E: the
 * default executor is disabled, and no recorder/transcript source is
 * available. A future durable implementation must call authorize() with the
 * authenticated actor and an immutable server-side source projection.
 */
@Injectable()
export class AiPostRoomService {
  constructor(
    @Inject(AI_POST_ROOM_EXECUTOR)
    private readonly executor: AiPostRoomExecutor,
  ) {}

  authorize(input: AiPostRoomAuthorizationInput): AiPostRoomAuthorizedRequest {
    try {
      return authorizeAiPostRoomRequest(input);
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  async request(input: AiPostRoomAuthorizationInput): Promise<AiPostRoomResponse> {
    try {
      const request = authorizeAiPostRoomRequest(input);
      const result = await this.executor.execute(request);
      return projectAiPostRoomResponse(request, result);
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private normalizeError(error: unknown): AiPostRoomFailure {
    if (error instanceof AiPostRoomFailure) return error;
    if (error instanceof AiContractError) {
      const status = error.code === 'AI_POST_ROOM_AUTHORIZATION' ? 403
        : error.code === 'AI_POST_ROOM_CONSENT_REQUIRED' || error.code === 'AI_POST_ROOM_CONSENT_REVOKED' ? 409
          : error.code === 'AI_POST_ROOM_RESULT_INVALID' ? 502
            : 422;
      const message = error.code === 'AI_POST_ROOM_CONSENT_REQUIRED'
        ? 'Post-room AI feedback requires explicit consent'
        : error.code === 'AI_POST_ROOM_CONSENT_REVOKED'
          ? 'Post-room AI consent is no longer active'
          : error.code === 'AI_POST_ROOM_AUTHORIZATION'
            ? 'Post-room AI feedback is not available for this participant'
            : error.code === 'AI_POST_ROOM_RESULT_INVALID'
              ? 'Post-room AI feedback was invalid'
              : 'Post-room AI request is invalid';
      return new AiPostRoomFailure(error.code, status, message);
    }
    if (error instanceof AiRuntimeError) {
      const status = error.code === 'AI_QUOTA_EXCEEDED' || error.code === 'AI_RATE_LIMITED'
        ? 429
        : error.code === 'AI_REQUEST_INVALID'
          ? 400
          : error.code === 'AI_INVALID_RESPONSE'
            ? 502
            : 503;
      return new AiPostRoomFailure(
        error.code,
        status,
        error.code === 'AI_PROVIDER_UNAVAILABLE'
          ? 'Post-room AI feedback is currently unavailable'
          : error.code === 'AI_INVALID_RESPONSE'
            ? 'Post-room AI feedback was invalid'
            : 'Post-room AI feedback could not be completed',
      );
    }
    return new AiPostRoomFailure(
      'AI_POST_ROOM_UNAVAILABLE',
      503,
      'Post-room AI feedback is currently unavailable',
    );
  }
}
