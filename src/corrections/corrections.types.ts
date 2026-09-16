import type {
  CommunityModerationState,
  CommunityPostCursor,
} from '../community/community.types';

export const CORRECTION_INTENTS = [
  'GRAMMAR',
  'STYLE',
  'NATURALNESS',
  'PRONUNCIATION',
] as const;

export type CorrectionIntent = typeof CORRECTION_INTENTS[number];

export const STRUCTURED_RESPONSE_KINDS = [
  'CORRECTION_PROPOSAL',
  'QA_ANSWER',
] as const;

export type StructuredResponseKind = typeof STRUCTURED_RESPONSE_KINDS[number];

export interface CorrectionRequestRecord {
  postId: string;
  originalText: string;
  correctionIntent: CorrectionIntent;
  context: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StructuredResponseRecord {
  id: string;
  parentPostId: string;
  authorUserId: string;
  responseKind: StructuredResponseKind;
  correctedText: string | null;
  answerText: string | null;
  explanation: string | null;
  moderationState: CommunityModerationState;
  createdAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  deletedByUserId: string | null;
}

export interface StructuredResponseInteractionRecord {
  helpfulCount: number;
  viewerHelpful: boolean;
  acceptedResponseId: string | null;
  acceptedAcceptanceId: string | null;
  acceptedByUserId: string | null;
  acceptedAt: Date | null;
  libraryCandidateState: LibraryCandidateState | null;
}

export interface StructuredResponseAcceptanceRecord {
  id: string;
  parentPostId: string;
  responseId: string;
  acceptedByUserId: string;
  acceptedAt: Date;
  revokedAt: Date | null;
}

export interface StructuredResponseListQuery {
  parentPostId: string;
  before?: CommunityPostCursor;
  limit: number;
}

export const LIBRARY_CANDIDATE_STATES = [
  'PENDING_REVIEW',
  'INVALIDATED',
] as const;

export type LibraryCandidateState = typeof LIBRARY_CANDIDATE_STATES[number];

export interface LibraryCandidateRecord {
  id: string;
  sourcePostId: string;
  sourceResponseId: string;
  contributorUserId: string;
  targetLanguageCode: string;
  responseKind: StructuredResponseKind;
  sourceText: string;
  correctedText: string | null;
  answerText: string | null;
  explanation: string | null;
  acceptanceId: string;
  acceptedByUserId: string;
  acceptedAt: Date;
  candidateCreatedByUserId: string;
  state: LibraryCandidateState;
  createdAt: Date;
  updatedAt: Date;
  invalidatedAt: Date | null;
  invalidationReason: string | null;
}

export const PHASE06_CONTRIBUTION_EVENT_TYPES = [
  'STRUCTURED_RESPONSE_CREATED',
  'RESPONSE_ACCEPTED',
  'ACCEPTANCE_REVOKED',
  'STRUCTURED_RESPONSE_MODERATED',
  'LIBRARY_CANDIDATE_CREATED',
] as const;

export type Phase06ContributionEventType = typeof PHASE06_CONTRIBUTION_EVENT_TYPES[number];

export interface Phase06ContributionEvent {
  id: string;
  eventType: Phase06ContributionEventType;
  idempotencyKey: string;
  aggregateId: string;
  parentPostId: string;
  responseId: string | null;
  candidateId: string | null;
  acceptanceId: string | null;
  actorUserId: string | null;
  contributorUserId: string | null;
  responseKind: StructuredResponseKind | null;
  moderationState: CommunityModerationState | null;
  occurredAt: Date;
}

export interface Phase06ContributionEventSink {
  publish(event: Phase06ContributionEvent): Promise<void>;
}
