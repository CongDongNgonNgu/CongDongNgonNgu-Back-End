import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY_REPOSITORY } from '../identity/identity.module';
import type { IdentityRepository } from '../identity/identity.repository';
import { PROFILE_REPOSITORY, type ProfileRepository } from '../profile/profile.repository';
import {
  CHALLENGE_REPOSITORY,
  ChallengeProgressReplayConflictError,
  ChallengeRepositoryConflictError,
  ChallengeRepositoryNotFoundError,
  type ChallengeRepository,
  type ChallengeListQuery,
} from './challenge.repository';
import {
  ChallengeRuleEngine,
  normalizeChallengeDefinition,
  type CreateChallengeDefinitionInput,
} from './challenge.rules';
import { ChallengeFailure, type ChallengeFailureCode } from './challenge.errors';
import type {
  ChallengeActivityType,
  ChallengeProgressProjection,
  ChallengeRecord,
  ChallengeStatus,
} from './challenge.types';

export interface ChallengeListInput {
  readonly status?: ChallengeStatus;
  readonly languageCode?: string;
  readonly limit?: number;
}

export interface RecordTrustedActivityInput {
  readonly activityType: ChallengeActivityType;
  readonly sourceId: string;
  readonly units: number;
  readonly occurredAt: Date;
}

export interface ChallengeProgressResponse {
  readonly outcome: 'CREATED' | 'REPLAYED';
  readonly projection: ChallengeProgressProjection;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

@Injectable()
export class ChallengeService {
  constructor(
    @Inject(CHALLENGE_REPOSITORY) private readonly repository: ChallengeRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository,
    private readonly rules: ChallengeRuleEngine,
  ) {}

  async createChallenge(input: CreateChallengeDefinitionInput): Promise<ChallengeRecord> {
    const normalized = this.normalizeDefinition(input);
    if (normalized.createdByUserId) {
      await this.requireActiveUser(normalized.createdByUserId, 'CHALLENGE_ACTOR_INVALID');
    }
    const languages = await this.profiles.findActiveByCodes([normalized.languageCode]);
    if (languages.length !== 1 || languages[0].code !== normalized.languageCode) {
      throw new ChallengeFailure(
        'CHALLENGE_LANGUAGE_UNAVAILABLE',
        422,
        'Challenge language is not available',
      );
    }
    try {
      return await this.repository.createChallenge(normalized);
    } catch (error) {
      throw this.mapRepositoryError(error, 'Challenge could not be created');
    }
  }

  async listChallenges(input: ChallengeListInput = {}): Promise<ChallengeRecord[]> {
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new ChallengeFailure('CHALLENGE_INVALID_INPUT', 400, 'Challenge page size is invalid');
    }
    const languageCode = input.languageCode?.trim().toLowerCase();
    if (languageCode !== undefined && !/^[a-z]{2,35}$/u.test(languageCode)) {
      throw new ChallengeFailure('CHALLENGE_INVALID_INPUT', 400, 'Challenge language is invalid');
    }
    const query: ChallengeListQuery = {
      status: input.status ?? 'ACTIVE',
      languageCode,
      limit,
    };
    return this.repository.listChallenges(query);
  }

  async getChallenge(challengeId: string): Promise<ChallengeRecord> {
    assertUuid(challengeId);
    const challenge = await this.repository.findChallengeById(challengeId);
    if (!challenge) throw new ChallengeFailure('CHALLENGE_NOT_FOUND', 404, 'Challenge is not available');
    return challenge;
  }

  async joinChallenge(challengeId: string, userId: string, now = new Date()) {
    assertUuid(challengeId);
    await this.requireActiveUser(userId, 'CHALLENGE_ACTOR_INVALID');
    const challenge = await this.requireChallenge(challengeId);
    if (challenge.status !== 'ACTIVE') {
      throw new ChallengeFailure('CHALLENGE_NOT_AVAILABLE', 409, 'Challenge is not accepting participants');
    }
    if (!isValidDate(now) || now.getTime() >= challenge.endAt.getTime()) {
      throw new ChallengeFailure('CHALLENGE_EXPIRED', 409, 'Challenge participation is closed');
    }
    try {
      return await this.repository.joinChallenge(challengeId, userId, now);
    } catch (error) {
      throw this.mapRepositoryError(error, 'Challenge participation could not be created');
    }
  }

  async leaveChallenge(challengeId: string, userId: string, now = new Date()) {
    assertUuid(challengeId);
    await this.requireActiveUser(userId, 'CHALLENGE_ACTOR_INVALID');
    await this.requireChallenge(challengeId);
    if (!isValidDate(now)) throw new ChallengeFailure('CHALLENGE_INVALID_INPUT', 400, 'Challenge time is invalid');
    try {
      return await this.repository.leaveChallenge(challengeId, userId, now);
    } catch (error) {
      if (error instanceof ChallengeRepositoryNotFoundError) {
        throw new ChallengeFailure('CHALLENGE_NOT_JOINED', 409, 'User is not participating in this challenge');
      }
      throw this.mapRepositoryError(error, 'Challenge participation could not be updated');
    }
  }

  async recordTrustedActivity(
    userId: string,
    challengeId: string,
    input: RecordTrustedActivityInput,
    now = new Date(),
  ): Promise<ChallengeProgressResponse> {
    assertUuid(challengeId);
    await this.requireActiveUser(userId, 'CHALLENGE_ACTOR_INVALID');
    const challenge = await this.requireChallenge(challengeId);
    const participation = await this.repository.findParticipation(challengeId, userId);
    if (!participation || participation.status === 'LEFT') {
      throw new ChallengeFailure('CHALLENGE_NOT_JOINED', 409, 'User is not participating in this challenge');
    }
    if (participation.status === 'COMPLETED') {
      throw new ChallengeFailure('CHALLENGE_ALREADY_COMPLETED', 409, 'Challenge participation is already complete');
    }
    const decision = this.rules.evaluateProgress({ challenge, userId, ...input }, now);
    if (!decision.eligible) {
      throw new ChallengeFailure(mapRuleFailureCode(decision.code), 422, decision.reason);
    }
    try {
      const result = await this.repository.appendProgress({
        challengeId,
        userId,
        activityType: decision.activityType,
        sourceId: decision.sourceId,
        units: decision.units,
        occurredAt: decision.occurredAt,
        ruleVersion: decision.ruleVersion,
        idempotencyKey: decision.idempotencyKey,
        fingerprint: decision.fingerprint,
        createdAt: now,
      });
      const projection = await this.repository.getProgress(challengeId, userId);
      if (!projection) throw new ChallengeFailure('CHALLENGE_NOT_FOUND', 404, 'Challenge progress is unavailable');
      return { outcome: result.replayed ? 'REPLAYED' : 'CREATED', projection };
    } catch (error) {
      if (error instanceof ChallengeProgressReplayConflictError) {
        throw new ChallengeFailure(
          'CHALLENGE_ACTIVITY_REPLAY_CONFLICT',
          409,
          'Challenge activity evidence conflicts with an existing event',
        );
      }
      if (error instanceof ChallengeRepositoryConflictError) {
        throw new ChallengeFailure('CHALLENGE_ALREADY_COMPLETED', 409, 'Challenge participation is already complete');
      }
      throw this.mapRepositoryError(error, 'Challenge progress could not be recorded');
    }
  }

  async getProgress(challengeId: string, userId: string): Promise<ChallengeProgressProjection> {
    assertUuid(challengeId);
    await this.requireActiveUser(userId, 'CHALLENGE_ACTOR_INVALID');
    const projection = await this.repository.getProgress(challengeId, userId);
    if (!projection) throw new ChallengeFailure('CHALLENGE_NOT_JOINED', 404, 'Challenge progress is unavailable');
    return projection;
  }

  private normalizeDefinition(input: CreateChallengeDefinitionInput) {
    try {
      return normalizeChallengeDefinition(input);
    } catch {
      throw new ChallengeFailure('CHALLENGE_INVALID_INPUT', 400, 'Challenge definition is invalid');
    }
  }

  private async requireChallenge(challengeId: string): Promise<ChallengeRecord> {
    const challenge = await this.repository.findChallengeById(challengeId);
    if (!challenge) throw new ChallengeFailure('CHALLENGE_NOT_FOUND', 404, 'Challenge is not available');
    return challenge;
  }

  private async requireActiveUser(userId: string | null, code: 'CHALLENGE_ACTOR_INVALID'): Promise<void> {
    if (!userId || !UUID_PATTERN.test(userId)) {
      throw new ChallengeFailure(code, 401, 'Challenge actor is invalid');
    }
    const user = await this.identities.findUserById(userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new ChallengeFailure(code, 403, 'Challenge actor is not active');
    }
  }

  private mapRepositoryError(error: unknown, fallback: string): ChallengeFailure {
    if (error instanceof ChallengeRepositoryNotFoundError) {
      return new ChallengeFailure('CHALLENGE_NOT_FOUND', 404, 'Challenge data is not available');
    }
    if (error instanceof ChallengeRepositoryConflictError) {
      return new ChallengeFailure('CHALLENGE_INVALID_INPUT', 409, fallback);
    }
    return error instanceof ChallengeFailure
      ? error
      : new ChallengeFailure('CHALLENGE_INVALID_INPUT', 500, fallback);
  }
}

function mapRuleFailureCode(code: Exclude<ChallengeFailureCode, 'CHALLENGE_INVALID_INPUT'> | string): ChallengeFailureCode {
  switch (code) {
    case 'CHALLENGE_ACTIVITY_INVALID':
      return 'CHALLENGE_ACTIVITY_INVALID';
    case 'CHALLENGE_ACTIVITY_NOT_ELIGIBLE':
      return 'CHALLENGE_ACTIVITY_NOT_ELIGIBLE';
    case 'CHALLENGE_ACTIVITY_IN_FUTURE':
      return 'CHALLENGE_ACTIVITY_IN_FUTURE';
    case 'CHALLENGE_EXPIRED':
      return 'CHALLENGE_EXPIRED';
    case 'CHALLENGE_NOT_ACTIVE':
      return 'CHALLENGE_NOT_ACTIVE';
    default:
      return 'CHALLENGE_INVALID_INPUT';
  }
}

function assertUuid(value: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ChallengeFailure('CHALLENGE_INVALID_INPUT', 400, 'Challenge identifier is invalid');
  }
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
