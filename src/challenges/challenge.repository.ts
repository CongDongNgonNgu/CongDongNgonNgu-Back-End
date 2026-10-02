import { randomUUID } from 'node:crypto';
import type {
  ChallengeActivityType,
  ChallengeParticipationRecord,
  ChallengeRecord,
  ChallengeProgressEventRecord,
  ChallengeProgressProjection,
  ChallengeStatus,
} from './challenge.types';

export const CHALLENGE_REPOSITORY = 'CHALLENGE_REPOSITORY';

export class ChallengeRepositoryConflictError extends Error {
  constructor(message = 'Challenge data conflicts with an existing record') {
    super(message);
    this.name = 'ChallengeRepositoryConflictError';
  }
}

export class ChallengeRepositoryNotFoundError extends Error {
  constructor(message = 'Challenge data was not found') {
    super(message);
    this.name = 'ChallengeRepositoryNotFoundError';
  }
}

export class ChallengeProgressReplayConflictError extends Error {
  constructor(message = 'Challenge progress replay conflicts with existing evidence') {
    super(message);
    this.name = 'ChallengeProgressReplayConflictError';
  }
}

export interface CreateChallengeRepositoryInput extends Omit<ChallengeRecord, 'id'> {}

export interface ChallengeListQuery {
  status?: ChallengeStatus;
  languageCode?: string;
  limit: number;
}

export interface JoinChallengeResult {
  record: ChallengeParticipationRecord;
  replayed: boolean;
}

export interface AppendChallengeProgressInput {
  challengeId: string;
  userId: string;
  activityType: ChallengeActivityType;
  sourceId: string;
  units: number;
  occurredAt: Date;
  ruleVersion: string;
  idempotencyKey: string;
  fingerprint: string;
  createdAt: Date;
}

export interface AppendChallengeProgressResult {
  event: ChallengeProgressEventRecord;
  participation: ChallengeParticipationRecord;
  replayed: boolean;
}

export interface ChallengeRepository {
  createChallenge(input: CreateChallengeRepositoryInput): Promise<ChallengeRecord>;
  findChallengeById(id: string): Promise<ChallengeRecord | null>;
  listChallenges(query: ChallengeListQuery): Promise<ChallengeRecord[]>;
  getParticipantCount(challengeId: string): Promise<number>;
  joinChallenge(challengeId: string, userId: string, now: Date): Promise<JoinChallengeResult>;
  leaveChallenge(challengeId: string, userId: string, now: Date): Promise<ChallengeParticipationRecord>;
  findParticipation(challengeId: string, userId: string): Promise<ChallengeParticipationRecord | null>;
  findProgressEvent(
    challengeId: string,
    userId: string,
    idempotencyKey: string,
  ): Promise<ChallengeProgressEventRecord | null>;
  appendProgress(input: AppendChallengeProgressInput): Promise<AppendChallengeProgressResult>;
  getProgress(challengeId: string, userId: string): Promise<ChallengeProgressProjection | null>;
}

export class InMemoryChallengeRepository implements ChallengeRepository {
  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly participations = new Map<string, ChallengeParticipationRecord>();
  private readonly progressEvents = new Map<string, ChallengeProgressEventRecord>();
  private readonly progressSourceKeys = new Map<string, string>();

  async createChallenge(input: CreateChallengeRepositoryInput): Promise<ChallengeRecord> {
    const record: ChallengeRecord = {
      ...cloneChallengeInput(input),
      id: randomUUID(),
    };
    this.challenges.set(record.id, record);
    return cloneChallenge(record);
  }

  async findChallengeById(id: string): Promise<ChallengeRecord | null> {
    const record = this.challenges.get(id);
    return record ? cloneChallenge(record) : null;
  }

  async listChallenges(query: ChallengeListQuery): Promise<ChallengeRecord[]> {
    return [...this.challenges.values()]
      .filter((challenge) => !query.status || challenge.status === query.status)
      .filter((challenge) => !query.languageCode || challenge.languageCode === query.languageCode)
      .sort((left, right) => left.startAt.getTime() - right.startAt.getTime() || left.id.localeCompare(right.id))
      .slice(0, query.limit)
      .map(cloneChallenge);
  }

  async getParticipantCount(challengeId: string): Promise<number> {
    return [...this.participations.values()]
      .filter((participation) => participation.challengeId === challengeId && participation.status !== 'LEFT')
      .length;
  }

  async joinChallenge(challengeId: string, userId: string, now: Date): Promise<JoinChallengeResult> {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new ChallengeRepositoryNotFoundError('Challenge does not exist');
    const key = participationKey(challengeId, userId);
    const existing = this.participations.get(key);
    if (existing && (existing.status === 'JOINED' || existing.status === 'COMPLETED')) {
      return { record: cloneParticipation(existing), replayed: true };
    }
    const record: ChallengeParticipationRecord = existing
      ? {
          ...existing,
          status: 'JOINED',
          joinedAt: new Date(now),
          leftAt: null,
          updatedAt: new Date(now),
        }
      : {
          id: randomUUID(),
          challengeId,
          userId,
          status: 'JOINED',
          joinedAt: new Date(now),
          leftAt: null,
          completedAt: null,
          progressValue: 0,
          createdAt: new Date(now),
          updatedAt: new Date(now),
        };
    this.participations.set(key, record);
    return { record: cloneParticipation(record), replayed: false };
  }

  async leaveChallenge(challengeId: string, userId: string, now: Date): Promise<ChallengeParticipationRecord> {
    const record = this.participations.get(participationKey(challengeId, userId));
    if (!record) throw new ChallengeRepositoryNotFoundError('Challenge participation does not exist');
    if (record.status !== 'COMPLETED') {
      record.status = 'LEFT';
      record.leftAt = new Date(now);
      record.updatedAt = new Date(now);
    }
    return cloneParticipation(record);
  }

  async findParticipation(challengeId: string, userId: string): Promise<ChallengeParticipationRecord | null> {
    const record = this.participations.get(participationKey(challengeId, userId));
    return record ? cloneParticipation(record) : null;
  }

  async findProgressEvent(
    challengeId: string,
    userId: string,
    idempotencyKey: string,
  ): Promise<ChallengeProgressEventRecord | null> {
    const record = this.progressEvents.get(idempotencyKey);
    return record && record.challengeId === challengeId && record.userId === userId
      ? cloneProgressEvent(record)
      : null;
  }

  async appendProgress(input: AppendChallengeProgressInput): Promise<AppendChallengeProgressResult> {
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge) throw new ChallengeRepositoryNotFoundError('Challenge does not exist');
    const participation = this.participations.get(participationKey(input.challengeId, input.userId));
    if (!participation) throw new ChallengeRepositoryNotFoundError('Challenge participation does not exist');

    const existing = this.progressEvents.get(input.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) throw new ChallengeProgressReplayConflictError();
      return {
        event: cloneProgressEvent(existing),
        participation: cloneParticipation(participation),
        replayed: true,
      };
    }
    if (participation.status === 'COMPLETED') throw new ChallengeRepositoryConflictError('Challenge is already complete');
    const sourceKey = progressSourceKey(input);
    const existingSourceKey = this.progressSourceKeys.get(sourceKey);
    if (existingSourceKey) throw new ChallengeProgressReplayConflictError();

    const event: ChallengeProgressEventRecord = {
      id: randomUUID(),
      challengeId: input.challengeId,
      userId: input.userId,
      activityType: input.activityType,
      sourceId: input.sourceId,
      units: input.units,
      occurredAt: new Date(input.occurredAt),
      ruleVersion: input.ruleVersion,
      idempotencyKey: input.idempotencyKey,
      fingerprint: input.fingerprint,
      createdAt: new Date(input.createdAt),
    };
    this.progressEvents.set(event.idempotencyKey, event);
    this.progressSourceKeys.set(sourceKey, event.idempotencyKey);
    participation.progressValue += event.units;
    if (participation.progressValue >= challenge.goal.target) {
      participation.status = 'COMPLETED';
      participation.completedAt = new Date(input.createdAt);
    }
    participation.updatedAt = new Date(input.createdAt);
    this.participations.set(participationKey(input.challengeId, input.userId), participation);
    return {
      event: cloneProgressEvent(event),
      participation: cloneParticipation(participation),
      replayed: false,
    };
  }

  async getProgress(challengeId: string, userId: string): Promise<ChallengeProgressProjection | null> {
    const challenge = this.challenges.get(challengeId);
    const participation = this.participations.get(participationKey(challengeId, userId));
    if (!challenge || !participation) return null;
    return {
      challengeId,
      userId,
      status: participation.status,
      progressValue: participation.progressValue,
      goal: { ...challenge.goal },
      completionPercent: Math.min(100, Math.floor((participation.progressValue / challenge.goal.target) * 100)),
      completedAt: participation.completedAt ? new Date(participation.completedAt) : null,
      rewardEvent: participation.status === 'COMPLETED' && challenge.reward
        ? {
            eventType: challenge.reward.eventType,
            challengeId,
            userId,
            ruleVersion: challenge.reward.ruleVersion,
            occurredAt: participation.completedAt ? new Date(participation.completedAt) : new Date(participation.updatedAt),
          }
        : null,
    };
  }
}

function participationKey(challengeId: string, userId: string): string {
  return `${challengeId}:${userId}`;
}

function progressSourceKey(input: AppendChallengeProgressInput): string {
  return `${input.challengeId}:${input.userId}:${input.activityType}:${input.sourceId}`;
}

function cloneChallengeInput(input: CreateChallengeRepositoryInput): CreateChallengeRepositoryInput {
  return {
    ...input,
    goal: { ...input.goal },
    eligibleActivityTypes: [...input.eligibleActivityTypes],
    reward: input.reward ? { ...input.reward } : null,
    startAt: new Date(input.startAt),
    endAt: new Date(input.endAt),
    createdAt: new Date(input.createdAt),
    updatedAt: new Date(input.updatedAt),
  };
}

function cloneChallenge(challenge: ChallengeRecord): ChallengeRecord {
  return {
    ...challenge,
    goal: { ...challenge.goal },
    eligibleActivityTypes: [...challenge.eligibleActivityTypes],
    reward: challenge.reward ? { ...challenge.reward } : null,
    startAt: new Date(challenge.startAt),
    endAt: new Date(challenge.endAt),
    createdAt: new Date(challenge.createdAt),
    updatedAt: new Date(challenge.updatedAt),
  };
}

function cloneParticipation(record: ChallengeParticipationRecord): ChallengeParticipationRecord {
  return {
    ...record,
    joinedAt: new Date(record.joinedAt),
    leftAt: record.leftAt ? new Date(record.leftAt) : null,
    completedAt: record.completedAt ? new Date(record.completedAt) : null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function cloneProgressEvent(record: ChallengeProgressEventRecord): ChallengeProgressEventRecord {
  return {
    ...record,
    occurredAt: new Date(record.occurredAt),
    createdAt: new Date(record.createdAt),
  };
}
