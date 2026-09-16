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
  acceptedAt: Date | null;
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

export interface Phase06ContributionEvent {
  eventType:
    | 'STRUCTURED_RESPONSE_CREATED'
    | 'RESPONSE_ACCEPTED'
    | 'ACCEPTANCE_REVOKED'
    | 'STRUCTURED_RESPONSE_MODERATED'
    | 'LIBRARY_CANDIDATE_CREATED';
  aggregateId: string;
  parentPostId: string;
  actorUserId: string;
  occurredAt: Date;
}

export interface Phase06ContributionEventSink {
  publish(event: Phase06ContributionEvent): Promise<void>;
}
