import type {
  ChallengeParticipationRecord,
  ChallengeProgressProjection,
  ChallengeRecord,
} from './challenge.types';

export const CHALLENGE_PUBLIC_STATES = ['UPCOMING', 'ACTIVE', 'EXPIRED', 'CANCELLED'] as const;
export type ChallengePublicState = (typeof CHALLENGE_PUBLIC_STATES)[number];

export interface ChallengePublicSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly challengeType: ChallengeRecord['challengeType'];
  readonly languageCode: string;
  readonly level: string | null;
  readonly topic: string | null;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly timezone: string;
  readonly goal: ChallengeRecord['goal'];
  readonly state: ChallengePublicState;
  readonly participantCount: number;
}

export interface ChallengePublicProgress {
  readonly status: ChallengeProgressProjection['status'];
  readonly progressValue: number;
  readonly goal: ChallengeProgressProjection['goal'];
  readonly completionPercent: number;
  readonly completedAt: Date | null;
}

export interface ChallengePublicParticipation {
  readonly status: ChallengeParticipationRecord['status'];
  readonly joinedAt: Date;
  readonly leftAt: Date | null;
  readonly completedAt: Date | null;
  readonly progressValue: number;
}

export interface ChallengePublicDetail extends ChallengePublicSummary {
  readonly progress: ChallengePublicProgress | null;
}

export function getChallengePublicState(
  challenge: Pick<ChallengeRecord, 'status' | 'startAt' | 'endAt'>,
  now: Date,
): ChallengePublicState {
  if (challenge.status === 'CANCELLED') return 'CANCELLED';
  if (now.getTime() < challenge.startAt.getTime()) return 'UPCOMING';
  if (now.getTime() >= challenge.endAt.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}

export function toPublicChallengeSummary(
  challenge: ChallengeRecord,
  participantCount: number,
  now: Date,
): ChallengePublicSummary {
  return {
    id: challenge.id,
    title: challenge.title,
    description: challenge.description,
    challengeType: challenge.challengeType,
    languageCode: challenge.languageCode,
    level: challenge.level,
    topic: challenge.topic,
    startAt: new Date(challenge.startAt),
    endAt: new Date(challenge.endAt),
    timezone: challenge.timezone,
    goal: { ...challenge.goal },
    state: getChallengePublicState(challenge, now),
    participantCount,
  };
}

export function toPublicProgress(
  projection: ChallengeProgressProjection,
): ChallengePublicProgress {
  return {
    status: projection.status,
    progressValue: projection.progressValue,
    goal: { ...projection.goal },
    completionPercent: projection.completionPercent,
    completedAt: projection.completedAt ? new Date(projection.completedAt) : null,
  };
}

export function toPublicParticipation(
  participation: ChallengeParticipationRecord,
): ChallengePublicParticipation {
  return {
    status: participation.status,
    joinedAt: new Date(participation.joinedAt),
    leftAt: participation.leftAt ? new Date(participation.leftAt) : null,
    completedAt: participation.completedAt ? new Date(participation.completedAt) : null,
    progressValue: participation.progressValue,
  };
}
