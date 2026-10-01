import { HttpException } from '@nestjs/common';

export type ChallengeFailureCode =
  | 'CHALLENGE_INVALID_INPUT'
  | 'CHALLENGE_ACTOR_INVALID'
  | 'CHALLENGE_LANGUAGE_UNAVAILABLE'
  | 'CHALLENGE_NOT_FOUND'
  | 'CHALLENGE_NOT_AVAILABLE'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_NOT_JOINED'
  | 'CHALLENGE_ALREADY_COMPLETED'
  | 'CHALLENGE_ACTIVITY_INVALID'
  | 'CHALLENGE_ACTIVITY_NOT_ELIGIBLE'
  | 'CHALLENGE_ACTIVITY_IN_FUTURE'
  | 'CHALLENGE_ACTIVITY_REPLAY_CONFLICT'
  | 'CHALLENGE_NOT_ACTIVE';

export class ChallengeFailure extends HttpException {
  constructor(
    readonly code: ChallengeFailureCode,
    status: number,
    message: string,
  ) {
    super({ code, message }, status);
    this.name = 'ChallengeFailure';
  }
}
