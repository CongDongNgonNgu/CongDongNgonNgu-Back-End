import { randomUUID } from 'node:crypto';
import type {
  CommunityCefrLevel,
  CommunityListResult,
  CommunityModerationState,
  CommunityPostCursor,
  CommunityPostRecord,
  CommunityPostType,
  CommunityVisibility,
} from '../community/community.types';
import type {
  CreateCommunityPostInput,
  CommunityRepository as CommunityPersistence,
} from '../community/community.repository';
import type {
  CorrectionIntent,
  CorrectionRequestRecord,
  LibraryCandidateRecord,
  LibraryCandidateState,
  Phase06ContributionEvent,
  StructuredResponseAcceptanceRecord,
  StructuredResponseInteractionRecord,
  StructuredResponseKind,
  StructuredResponseListQuery,
  StructuredResponseRecord,
} from './corrections.types';
import {
  evaluatePhase06SourceHealth,
} from './corrections.source-health';
import type {
  Phase06SourceHealth,
  Phase06SourceReference,
} from './corrections.source-health';

export const CORRECTIONS_REPOSITORY = 'CORRECTIONS_REPOSITORY';

export class CorrectionsRepositoryConflictError extends Error {
  constructor(message = 'Corrections data conflicts with existing records') {
    super(message);
    this.name = 'CorrectionsRepositoryConflictError';
  }
}

export interface CreateCorrectionRequestRepositoryInput {
  authorUserId: string;
  targetLanguageCode: string;
  parentContent: string;
  cefrLevel: CommunityCefrLevel | null;
  topic: string | null;
  visibility: CommunityVisibility;
  originalText: string;
  correctionIntent: CorrectionIntent;
  context: string | null;
  createdAt: Date;
}

export interface CreateQuestionRepositoryInput {
  authorUserId: string;
  targetLanguageCode: string;
  content: string;
  cefrLevel: CommunityCefrLevel | null;
  topic: string | null;
  visibility: CommunityVisibility;
  createdAt: Date;
}

export interface CreateStructuredResponseRepositoryInput {
  parentPostId: string;
  parentPostType: Extract<CommunityPostType, 'QUESTION' | 'CORRECTION_REQUEST'>;
  authorUserId: string;
  responseKind: StructuredResponseKind;
  correctedText: string | null;
  answerText: string | null;
  explanation: string | null;
  createdAt: Date;
}

export interface CreateStructuredResponseAcceptanceRepositoryInput {
  parentPostId: string;
  responseId: string;
  acceptedByUserId: string;
  acceptedAt: Date;
}

export interface CreateLibraryCandidateRepositoryInput {
  responseId: string;
  candidateCreatedByUserId: string;
  createdAt: Date;
}

export interface Phase06ContributionEventQuery {
  parentPostId?: string;
  responseId?: string;
  candidateId?: string;
}

export interface CorrectionsRepository {
  createCorrectionRequest(
    input: CreateCorrectionRequestRepositoryInput,
  ): Promise<{ post: CommunityPostRecord; correction: CorrectionRequestRecord }>;
  createQuestion(input: CreateQuestionRepositoryInput): Promise<CommunityPostRecord>;
  findCorrectionRequest(postId: string): Promise<CorrectionRequestRecord | null>;
  createStructuredResponse(
    input: CreateStructuredResponseRepositoryInput,
  ): Promise<StructuredResponseRecord>;
  findStructuredResponseById(id: string): Promise<StructuredResponseRecord | null>;
  listStructuredResponses(
    query: StructuredResponseListQuery,
  ): Promise<CommunityListResult<StructuredResponseRecord>>;
  getStructuredResponseInteraction(
    responseId: string,
    viewerUserId: string | null,
  ): Promise<StructuredResponseInteractionRecord>;
  addStructuredResponseHelpfulVote(
    responseId: string,
    userId: string,
    createdAt: Date,
  ): Promise<void>;
  removeStructuredResponseHelpfulVote(
    responseId: string,
    userId: string,
  ): Promise<void>;
  setStructuredResponseAcceptance(
    input: CreateStructuredResponseAcceptanceRepositoryInput,
  ): Promise<StructuredResponseAcceptanceRecord>;
  revokeStructuredResponseAcceptance(
    parentPostId: string,
    acceptedByUserId: string,
    revokedAt: Date,
  ): Promise<StructuredResponseAcceptanceRecord | null>;
  setStructuredResponseModerationState(
    id: string,
    moderationState: CommunityModerationState,
    now: Date,
    actorUserId?: string | null,
  ): Promise<StructuredResponseRecord | null>;
  createLibraryCandidate(
    input: CreateLibraryCandidateRepositoryInput,
  ): Promise<LibraryCandidateRecord>;
  findLibraryCandidateById(id: string): Promise<LibraryCandidateRecord | null>;
  inspectLibraryCandidateSource(reference: Phase06SourceReference): Promise<Phase06SourceHealth>;
  listPendingLibraryCandidates(limit?: number): Promise<LibraryCandidateRecord[]>;
  listContributionEvents(
    query?: Phase06ContributionEventQuery,
  ): Promise<Phase06ContributionEvent[]>;
}

export class InMemoryCorrectionsRepository implements CorrectionsRepository {
  private readonly correctionRequests = new Map<string, CorrectionRequestRecord>();
  private readonly responses = new Map<string, StructuredResponseRecord>();
  private readonly helpfulVotes = new Map<string, Date>();
  private readonly acceptances = new Map<string, StructuredResponseAcceptanceRecord[]>();
  private readonly candidates = new Map<string, LibraryCandidateRecord>();
  private readonly contributionEvents: Phase06ContributionEvent[] = [];

  constructor(private readonly community: CommunityPersistence) {}

  async createCorrectionRequest(
    input: CreateCorrectionRequestRepositoryInput,
  ): Promise<{ post: CommunityPostRecord; correction: CorrectionRequestRecord }> {
    const postInput: CreateCommunityPostInput = {
      authorUserId: input.authorUserId,
      targetLanguageCode: input.targetLanguageCode,
      postType: 'CORRECTION_REQUEST',
      content: input.parentContent,
      cefrLevel: input.cefrLevel,
      topic: input.topic,
      visibility: input.visibility,
      createdAt: input.createdAt,
    };
    const post = await this.community.createPost(postInput);
    if (this.correctionRequests.has(post.id)) {
      throw new CorrectionsRepositoryConflictError('Correction request already exists');
    }
    const correction: CorrectionRequestRecord = {
      postId: post.id,
      originalText: input.originalText,
      correctionIntent: input.correctionIntent,
      context: input.context,
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.createdAt),
    };
    this.correctionRequests.set(post.id, correction);
    return { post, correction: cloneCorrection(correction) };
  }

  async createQuestion(input: CreateQuestionRepositoryInput): Promise<CommunityPostRecord> {
    return this.community.createPost({
      authorUserId: input.authorUserId,
      targetLanguageCode: input.targetLanguageCode,
      postType: 'QUESTION',
      content: input.content,
      cefrLevel: input.cefrLevel,
      topic: input.topic,
      visibility: input.visibility,
      createdAt: input.createdAt,
    });
  }

  async findCorrectionRequest(postId: string): Promise<CorrectionRequestRecord | null> {
    const correction = this.correctionRequests.get(postId);
    return correction ? cloneCorrection(correction) : null;
  }

  async createStructuredResponse(
    input: CreateStructuredResponseRepositoryInput,
  ): Promise<StructuredResponseRecord> {
    const parent = await this.community.findPostById(input.parentPostId);
    if (
      !parent ||
      parent.moderationState !== 'ACTIVE' ||
      parent.postType !== input.parentPostType ||
      (input.responseKind === 'CORRECTION_PROPOSAL' && parent.postType !== 'CORRECTION_REQUEST') ||
      (input.responseKind === 'QA_ANSWER' && parent.postType !== 'QUESTION')
    ) {
      throw new CorrectionsRepositoryConflictError('Structured response parent is invalid');
    }
    const record: StructuredResponseRecord = {
      id: randomUUID(),
      parentPostId: input.parentPostId,
      authorUserId: input.authorUserId,
      responseKind: input.responseKind,
      correctedText: input.correctedText,
      answerText: input.answerText,
      explanation: input.explanation,
      moderationState: 'ACTIVE',
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.createdAt),
      editedAt: null,
      deletedAt: null,
      deletedByUserId: null,
    };
    this.responses.set(record.id, record);
    this.appendContributionEvent({
      eventType: 'STRUCTURED_RESPONSE_CREATED',
      idempotencyKey: `response:${record.id}:created`,
      aggregateId: record.id,
      parentPostId: record.parentPostId,
      responseId: record.id,
      candidateId: null,
      acceptanceId: null,
      actorUserId: record.authorUserId,
      contributorUserId: record.authorUserId,
      responseKind: record.responseKind,
      moderationState: record.moderationState,
      occurredAt: input.createdAt,
    });
    return cloneResponse(record);
  }

  async findStructuredResponseById(id: string): Promise<StructuredResponseRecord | null> {
    const response = this.responses.get(id);
    return response ? cloneResponse(response) : null;
  }

  async listStructuredResponses(
    query: StructuredResponseListQuery,
  ): Promise<CommunityListResult<StructuredResponseRecord>> {
    const items = [...this.responses.values()]
      .filter((response) => (
        response.parentPostId === query.parentPostId &&
        response.moderationState !== 'HIDDEN' &&
        isBeforeCursor(response, query.before)
      ))
      .sort(compareNewestFirst);
    return page(items, query.limit);
  }

  async getStructuredResponseInteraction(
    responseId: string,
    viewerUserId: string | null,
  ): Promise<StructuredResponseInteractionRecord> {
    let helpfulCount = 0;
    let viewerHelpful = false;
    for (const key of this.helpfulVotes.keys()) {
      const [voteResponseId, voteUserId] = key.split(':');
      if (voteResponseId !== responseId) continue;
      helpfulCount += 1;
      if (viewerUserId && voteUserId === viewerUserId) viewerHelpful = true;
    }
    const response = this.responses.get(responseId);
    const activeAcceptance = response
      ? this.getActiveAcceptance(response.parentPostId)
      : null;
    return {
      helpfulCount,
      viewerHelpful,
      acceptedResponseId: activeAcceptance?.responseId ?? null,
      acceptedAcceptanceId: activeAcceptance?.id ?? null,
      acceptedByUserId: activeAcceptance?.acceptedByUserId ?? null,
      acceptedAt: activeAcceptance ? new Date(activeAcceptance.acceptedAt) : null,
      libraryCandidateState: [...this.candidates.values()]
        .find((candidate) => candidate.sourceResponseId === responseId && candidate.state === 'PENDING_REVIEW')
        ?.state ?? null,
    };
  }

  async addStructuredResponseHelpfulVote(
    responseId: string,
    userId: string,
    createdAt: Date,
  ): Promise<void> {
    const key = responseVoteKey(responseId, userId);
    if (!this.helpfulVotes.has(key)) this.helpfulVotes.set(key, new Date(createdAt));
  }

  async removeStructuredResponseHelpfulVote(
    responseId: string,
    userId: string,
  ): Promise<void> {
    this.helpfulVotes.delete(responseVoteKey(responseId, userId));
  }

  async setStructuredResponseAcceptance(
    input: CreateStructuredResponseAcceptanceRepositoryInput,
  ): Promise<StructuredResponseAcceptanceRecord> {
    const history = this.acceptances.get(input.parentPostId) ?? [];
    const active = history.find((acceptance) => acceptance.revokedAt === null);
    if (active?.responseId === input.responseId) return cloneAcceptance(active);
    if (active) {
      active.revokedAt = new Date(input.acceptedAt);
      this.invalidateCandidatesForResponse(active.responseId, active.id, input.acceptedAt, 'ACCEPTANCE_REVOKED');
      this.appendContributionEvent({
        eventType: 'ACCEPTANCE_REVOKED',
        idempotencyKey: `acceptance:${active.id}:revoked`,
        aggregateId: active.id,
        parentPostId: active.parentPostId,
        responseId: active.responseId,
        candidateId: null,
        acceptanceId: active.id,
        actorUserId: input.acceptedByUserId,
        contributorUserId: this.responses.get(active.responseId)?.authorUserId ?? null,
        responseKind: this.responses.get(active.responseId)?.responseKind ?? null,
        moderationState: null,
        occurredAt: input.acceptedAt,
      });
    }
    const created: StructuredResponseAcceptanceRecord = {
      id: randomUUID(),
      parentPostId: input.parentPostId,
      responseId: input.responseId,
      acceptedByUserId: input.acceptedByUserId,
      acceptedAt: new Date(input.acceptedAt),
      revokedAt: null,
    };
    history.push(created);
    this.acceptances.set(input.parentPostId, history);
    const response = this.responses.get(input.responseId);
    this.appendContributionEvent({
      eventType: 'RESPONSE_ACCEPTED',
      idempotencyKey: `acceptance:${created.id}:accepted`,
      aggregateId: created.id,
      parentPostId: created.parentPostId,
      responseId: created.responseId,
      candidateId: null,
      acceptanceId: created.id,
      actorUserId: created.acceptedByUserId,
      contributorUserId: response?.authorUserId ?? null,
      responseKind: response?.responseKind ?? null,
      moderationState: null,
      occurredAt: created.acceptedAt,
    });
    return cloneAcceptance(created);
  }

  async revokeStructuredResponseAcceptance(
    parentPostId: string,
    _acceptedByUserId: string,
    revokedAt: Date,
  ): Promise<StructuredResponseAcceptanceRecord | null> {
    const active = this.getActiveAcceptance(parentPostId);
    if (!active) return null;
    active.revokedAt = new Date(revokedAt);
    this.invalidateCandidatesForResponse(active.responseId, active.id, revokedAt, 'ACCEPTANCE_REVOKED');
    const response = this.responses.get(active.responseId);
    this.appendContributionEvent({
      eventType: 'ACCEPTANCE_REVOKED',
      idempotencyKey: `acceptance:${active.id}:revoked`,
      aggregateId: active.id,
      parentPostId: active.parentPostId,
      responseId: active.responseId,
      candidateId: null,
      acceptanceId: active.id,
      actorUserId: _acceptedByUserId,
      contributorUserId: response?.authorUserId ?? null,
      responseKind: response?.responseKind ?? null,
      moderationState: null,
      occurredAt: revokedAt,
    });
    return cloneAcceptance(active);
  }

  async setStructuredResponseModerationState(
    id: string,
    moderationState: CommunityModerationState,
    now: Date,
    actorUserId: string | null = null,
  ): Promise<StructuredResponseRecord | null> {
    const response = this.responses.get(id);
    if (!response) return null;
    response.moderationState = moderationState;
    response.updatedAt = new Date(now);
    if (moderationState === 'DELETED' && !response.deletedAt) {
      response.deletedAt = new Date(now);
    }
    if (moderationState !== 'ACTIVE') {
      this.invalidateCandidatesForResponse(response.id, null, now, 'RESPONSE_MODERATED');
    }
    this.appendContributionEvent({
      eventType: 'STRUCTURED_RESPONSE_MODERATED',
      idempotencyKey: `response:${response.id}:moderated:${moderationState}:${now.toISOString()}`,
      aggregateId: response.id,
      parentPostId: response.parentPostId,
      responseId: response.id,
      candidateId: null,
      acceptanceId: this.getActiveAcceptance(response.parentPostId)?.id ?? null,
      actorUserId,
      contributorUserId: response.authorUserId,
      responseKind: response.responseKind,
      moderationState,
      occurredAt: now,
    });
    return cloneResponse(response);
  }

  async createLibraryCandidate(
    input: CreateLibraryCandidateRepositoryInput,
  ): Promise<LibraryCandidateRecord> {
    const response = this.responses.get(input.responseId);
    if (!response || response.moderationState !== 'ACTIVE') {
      throw new CorrectionsRepositoryConflictError('Structured response is unavailable');
    }
    const parent = await this.community.findPostById(response.parentPostId);
    const acceptance = this.getActiveAcceptance(response.parentPostId);
    if (!parent || parent.moderationState !== 'ACTIVE' || parent.visibility !== 'PUBLIC' || !acceptance || acceptance.responseId !== response.id) {
      throw new CorrectionsRepositoryConflictError('Library candidate source is unavailable');
    }
    const existing = [...this.candidates.values()].find((candidate) => (
      candidate.sourceResponseId === response.id && candidate.state === 'PENDING_REVIEW'
    ));
    if (existing) return cloneCandidate(existing);
    const correction = response.responseKind === 'CORRECTION_PROPOSAL'
      ? await this.findCorrectionRequest(response.parentPostId)
      : null;
    const candidate: LibraryCandidateRecord = {
      id: randomUUID(),
      sourcePostId: parent.id,
      sourceResponseId: response.id,
      contributorUserId: response.authorUserId,
      targetLanguageCode: parent.targetLanguageCode,
      responseKind: response.responseKind,
      sourceText: correction?.originalText ?? parent.content,
      correctedText: response.correctedText,
      answerText: response.answerText,
      explanation: response.explanation,
      acceptanceId: acceptance.id,
      acceptedByUserId: acceptance.acceptedByUserId,
      acceptedAt: new Date(acceptance.acceptedAt),
      candidateCreatedByUserId: input.candidateCreatedByUserId,
      state: 'PENDING_REVIEW',
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.createdAt),
      invalidatedAt: null,
      invalidationReason: null,
    };
    this.candidates.set(candidate.id, candidate);
    this.appendContributionEvent({
      eventType: 'LIBRARY_CANDIDATE_CREATED',
      idempotencyKey: `candidate:${candidate.id}:created`,
      aggregateId: candidate.id,
      parentPostId: candidate.sourcePostId,
      responseId: candidate.sourceResponseId,
      candidateId: candidate.id,
      acceptanceId: candidate.acceptanceId,
      actorUserId: candidate.candidateCreatedByUserId,
      contributorUserId: candidate.contributorUserId,
      responseKind: candidate.responseKind,
      moderationState: null,
      occurredAt: candidate.createdAt,
    });
    return cloneCandidate(candidate);
  }

  async listPendingLibraryCandidates(limit = 100): Promise<LibraryCandidateRecord[]> {
    const visible = await Promise.all([...this.candidates.values()]
      .filter((candidate) => candidate.state === 'PENDING_REVIEW')
      .map(async (candidate) => {
        const parent = await this.community.findPostById(candidate.sourcePostId);
        const response = this.responses.get(candidate.sourceResponseId);
        const acceptance = this.getActiveAcceptance(candidate.sourcePostId);
        return Boolean(
          parent &&
          parent.moderationState === 'ACTIVE' &&
          parent.visibility === 'PUBLIC' &&
          response?.moderationState === 'ACTIVE' &&
          acceptance?.id === candidate.acceptanceId &&
          acceptance.responseId === candidate.sourceResponseId,
        ) ? candidate : null;
      }));
    return visible
      .filter((candidate): candidate is LibraryCandidateRecord => Boolean(candidate))
      .sort(compareNewestFirst)
      .slice(0, limit)
      .map(cloneCandidate);
  }

  async findLibraryCandidateById(id: string): Promise<LibraryCandidateRecord | null> {
    const candidate = this.candidates.get(id);
    if (!candidate || candidate.state !== 'PENDING_REVIEW') return null;
    const parent = await this.community.findPostById(candidate.sourcePostId);
    const response = this.responses.get(candidate.sourceResponseId);
    const acceptance = this.getActiveAcceptance(candidate.sourcePostId);
    if (
      !parent ||
      parent.moderationState !== 'ACTIVE' ||
      parent.visibility !== 'PUBLIC' ||
      response?.moderationState !== 'ACTIVE' ||
      acceptance?.id !== candidate.acceptanceId ||
      acceptance.responseId !== candidate.sourceResponseId
    ) return null;
    return cloneCandidate(candidate);
  }

  async inspectLibraryCandidateSource(
    reference: Phase06SourceReference,
  ): Promise<Phase06SourceHealth> {
    const candidate = this.candidates.get(reference.sourceCandidateId);
    if (!candidate) return evaluatePhase06SourceHealth(reference, null);
    const parent = await this.community.findPostById(candidate.sourcePostId);
    const response = this.responses.get(candidate.sourceResponseId);
    const acceptance = [...this.acceptances.values()]
      .flat()
      .find((entry) => entry.id === candidate.acceptanceId);
    const currentAcceptance = this.getActiveAcceptance(candidate.sourcePostId);
    return evaluatePhase06SourceHealth(reference, {
      candidateId: candidate.id,
      candidateState: candidate.state,
      candidateSourcePostId: candidate.sourcePostId,
      candidateSourceResponseId: candidate.sourceResponseId,
      candidateAcceptanceId: candidate.acceptanceId,
      postExists: Boolean(parent),
      postModerationState: parent?.moderationState ?? null,
      postVisibility: parent?.visibility ?? null,
      responseExists: Boolean(response),
      responseParentPostId: response?.parentPostId ?? null,
      responseModerationState: response?.moderationState ?? null,
      acceptanceExists: Boolean(acceptance),
      acceptanceParentPostId: acceptance?.parentPostId ?? null,
      acceptanceResponseId: acceptance?.responseId ?? null,
      acceptanceRevokedAt: acceptance?.revokedAt?.toISOString() ?? null,
      currentAcceptanceId: currentAcceptance?.id ?? null,
      currentAcceptanceResponseId: currentAcceptance?.responseId ?? null,
    });
  }

  async listContributionEvents(
    query: Phase06ContributionEventQuery = {},
  ): Promise<Phase06ContributionEvent[]> {
    return this.contributionEvents
      .filter((event) => !query.parentPostId || event.parentPostId === query.parentPostId)
      .filter((event) => !query.responseId || event.responseId === query.responseId)
      .filter((event) => !query.candidateId || event.candidateId === query.candidateId)
      .map(cloneContributionEvent);
  }

  private getActiveAcceptance(parentPostId: string): StructuredResponseAcceptanceRecord | null {
    return this.acceptances.get(parentPostId)?.find((acceptance) => acceptance.revokedAt === null) ?? null;
  }

  private invalidateCandidatesForResponse(
    responseId: string,
    acceptanceId: string | null,
    now: Date,
    reason: string,
  ): void {
    for (const candidate of this.candidates.values()) {
      if (
        candidate.sourceResponseId === responseId &&
        candidate.state === 'PENDING_REVIEW' &&
        (!acceptanceId || candidate.acceptanceId === acceptanceId)
      ) {
        candidate.state = 'INVALIDATED';
        candidate.updatedAt = new Date(now);
        candidate.invalidatedAt = new Date(now);
        candidate.invalidationReason = reason;
      }
    }
  }

  private appendContributionEvent(
    event: Omit<Phase06ContributionEvent, 'id'>,
  ): void {
    if (this.contributionEvents.some((existing) => existing.idempotencyKey === event.idempotencyKey)) return;
    this.contributionEvents.push({ id: randomUUID(), ...event });
  }
}

function page<T>(items: T[], limit: number): CommunityListResult<T> {
  return {
    items: items.slice(0, limit),
    hasMore: items.length > limit,
  };
}

function isBeforeCursor(
  record: { createdAt: Date; id: string },
  cursor: CommunityPostCursor | undefined,
): boolean {
  if (!cursor) return true;
  const recordTime = record.createdAt.getTime();
  const cursorTime = cursor.createdAt.getTime();
  return recordTime < cursorTime || (recordTime === cursorTime && record.id < cursor.id);
}

function compareNewestFirst(
  left: { createdAt: Date; id: string },
  right: { createdAt: Date; id: string },
): number {
  const timeDifference = right.createdAt.getTime() - left.createdAt.getTime();
  if (timeDifference !== 0) return timeDifference;
  return right.id.localeCompare(left.id);
}

function cloneCorrection(correction: CorrectionRequestRecord): CorrectionRequestRecord {
  return {
    ...correction,
    createdAt: new Date(correction.createdAt),
    updatedAt: new Date(correction.updatedAt),
  };
}

function cloneResponse(response: StructuredResponseRecord): StructuredResponseRecord {
  return {
    ...response,
    createdAt: new Date(response.createdAt),
    updatedAt: new Date(response.updatedAt),
    editedAt: response.editedAt ? new Date(response.editedAt) : null,
    deletedAt: response.deletedAt ? new Date(response.deletedAt) : null,
  };
}

function responseVoteKey(responseId: string, userId: string): string {
  return responseId + ':' + userId;
}

function cloneAcceptance(
  acceptance: StructuredResponseAcceptanceRecord,
): StructuredResponseAcceptanceRecord {
  return {
    ...acceptance,
    acceptedAt: new Date(acceptance.acceptedAt),
    revokedAt: acceptance.revokedAt ? new Date(acceptance.revokedAt) : null,
  };
}

function cloneCandidate(candidate: LibraryCandidateRecord): LibraryCandidateRecord {
  return {
    ...candidate,
    acceptedAt: new Date(candidate.acceptedAt),
    createdAt: new Date(candidate.createdAt),
    updatedAt: new Date(candidate.updatedAt),
    invalidatedAt: candidate.invalidatedAt ? new Date(candidate.invalidatedAt) : null,
  };
}

function cloneContributionEvent(event: Phase06ContributionEvent): Phase06ContributionEvent {
  return { ...event, occurredAt: new Date(event.occurredAt) };
}
