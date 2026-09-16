import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY_REPOSITORY } from '../identity/identity.module';
import type { IdentityRepository } from '../identity/identity.repository';
import type { UserRecord } from '../identity/identity.types';
import { PROFILE_REPOSITORY } from '../profile/profile.repository';
import type { ProfileRepository } from '../profile/profile.repository';
import {
  normalizeCefrLevel,
  normalizeCommunityTopic,
  normalizeVisibility,
  CommunityValidationError,
} from '../community/community.normalization';
import {
  decodeCommunityCursor,
  encodeCommunityCursor,
} from '../community/community.pagination';
import { CommunityFailure } from '../community/community.errors';
import { CommunityRateLimiter } from '../community/community.rate-limiter';
import {
  CommunityService,
  type CommunityPostResponse,
} from '../community/community.service';
import type {
  CommunityCefrLevel,
  CommunityPostCursor,
  CommunityPostType,
  CommunityVisibility,
} from '../community/community.types';
import {
  CORRECTIONS_REPOSITORY,
  CorrectionsRepositoryConflictError,
  type CorrectionsRepository,
} from './corrections.repository';
import {
  MAX_PHASE06_CONTEXT_CODE_POINTS,
  MAX_PHASE06_EXPLANATION_CODE_POINTS,
  normalizeCorrectionIntent,
  normalizePhase06OptionalText,
  normalizePhase06Text,
  normalizeStructuredResponseKind,
  Phase06ValidationError,
} from './corrections.normalization';
import { correctionsFailure } from './corrections.errors';
import type {
  CorrectionIntent,
  CorrectionRequestRecord,
  LibraryCandidateRecord,
  StructuredResponseKind,
  StructuredResponseRecord,
} from './corrections.types';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export interface CreateCorrectionRequestInput {
  languageCode: unknown;
  originalText: unknown;
  correctionIntent: unknown;
  context?: unknown;
  cefrLevel?: unknown;
  topic?: unknown;
  visibility?: unknown;
}

export interface CreateQuestionInput {
  languageCode: unknown;
  content: unknown;
  cefrLevel?: unknown;
  topic?: unknown;
  visibility?: unknown;
}

export interface CreateStructuredResponseInput {
  responseKind: unknown;
  correctedText?: unknown;
  answerText?: unknown;
  explanation?: unknown;
}

export interface ListStructuredResponsesInput {
  limit?: number;
  cursor?: unknown;
}

export interface CorrectionRequestResponse {
  post: CommunityPostResponse;
  correction: CorrectionRequestRecord;
}

export interface StructuredResponseAuthorResponse {
  id: string;
  displayName: string;
}

export interface StructuredResponseResponse {
  id: string;
  parentPostId: string;
  author: StructuredResponseAuthorResponse | null;
  responseKind: StructuredResponseKind;
  correctedText: string | null;
  answerText: string | null;
  explanation: string | null;
  createdAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
  isDeleted: boolean;
  helpfulCount: number;
  viewerHelpful: boolean;
  isAccepted: boolean;
  acceptedAt: Date | null;
  libraryCandidateState: 'PENDING_REVIEW' | 'INVALIDATED' | null;
  canAccept: boolean;
  canVote: boolean;
  canNominateCandidate: boolean;
}

export interface LibraryCandidateResponse {
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
  state: 'PENDING_REVIEW' | 'INVALIDATED';
  submittedForReview: true;
  createdAt: Date;
}

export interface StructuredResponseAcceptanceResponse {
  parentPostId: string;
  responseId: string | null;
  acceptedAt: Date | null;
  revoked: boolean;
}

export interface StructuredResponseListResponse {
  items: StructuredResponseResponse[];
  nextCursor: string | null;
}

@Injectable()
export class CorrectionsService {
  constructor(
    @Inject(CORRECTIONS_REPOSITORY) private readonly repository: CorrectionsRepository,
    private readonly community: CommunityService,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository,
    private readonly rateLimiter: CommunityRateLimiter,
  ) {}

  async createCorrectionRequest(
    userId: string,
    input: CreateCorrectionRequestInput,
  ): Promise<CorrectionRequestResponse> {
    await this.requireActiveUser(userId);
    const targetLanguageCode = await this.requireActiveLanguage(input.languageCode);
    const originalText = this.normalizePhase06(() => normalizePhase06Text(input.originalText));
    const correctionIntent = this.normalizePhase06(() => normalizeCorrectionIntent(input.correctionIntent));
    const context = this.normalizePhase06(() => normalizePhase06OptionalText(
      input.context,
      MAX_PHASE06_CONTEXT_CODE_POINTS,
    ));
    const metadata = this.normalizeMetadata(() => ({
      cefrLevel: normalizeCefrLevel(input.cefrLevel),
      topic: normalizeCommunityTopic(input.topic),
      visibility: normalizeVisibility(input.visibility),
    }));
    this.consumeRate('correction-request', userId, { limit: 10, windowMs: 15 * 60 * 1000 });

    try {
      const created = await this.repository.createCorrectionRequest({
        authorUserId: userId,
        targetLanguageCode,
        parentContent: context ?? originalText,
        cefrLevel: metadata.cefrLevel,
        topic: metadata.topic,
        visibility: metadata.visibility,
        originalText,
        correctionIntent,
        context,
        createdAt: new Date(),
      });
      return {
        post: await this.community.getPost(created.post.id, userId),
        correction: created.correction,
      };
    } catch (error) {
      if (error instanceof CorrectionsRepositoryConflictError) {
        return correctionsFailure(
          'CORRECTIONS_CREATE_CONFLICT',
          'The correction request could not be created',
        );
      }
      throw error;
    }
  }

  async createQuestion(
    userId: string,
    input: CreateQuestionInput,
  ): Promise<CommunityPostResponse> {
    await this.requireActiveUser(userId);
    const targetLanguageCode = await this.requireActiveLanguage(input.languageCode);
    const content = this.normalizePhase06(() => normalizePhase06Text(input.content));
    const metadata = this.normalizeMetadata(() => ({
      cefrLevel: normalizeCefrLevel(input.cefrLevel),
      topic: normalizeCommunityTopic(input.topic),
      visibility: normalizeVisibility(input.visibility),
    }));
    this.consumeRate('question', userId, { limit: 10, windowMs: 15 * 60 * 1000 });

    try {
      const post = await this.repository.createQuestion({
        authorUserId: userId,
        targetLanguageCode,
        content,
        cefrLevel: metadata.cefrLevel,
        topic: metadata.topic,
        visibility: metadata.visibility,
        createdAt: new Date(),
      });
      return this.community.getPost(post.id, userId);
    } catch (error) {
      if (error instanceof CorrectionsRepositoryConflictError) {
        return correctionsFailure(
          'CORRECTIONS_CREATE_CONFLICT',
          'The question could not be created',
        );
      }
      throw error;
    }
  }

  async getCorrectionRequest(
    postId: string,
    viewerUserId: string | null = null,
  ): Promise<CorrectionRequestResponse> {
    const post = await this.requireVisibleParent(postId, viewerUserId);
    if (post.postType !== 'CORRECTION_REQUEST') {
      return correctionsFailure(
        'CORRECTIONS_PARENT_TYPE_INVALID',
        'The post is not a correction request',
        404,
      );
    }
    const correction = await this.repository.findCorrectionRequest(postId);
    if (!correction) {
      return correctionsFailure(
        'CORRECTIONS_PARENT_UNAVAILABLE',
        'The correction request is not available',
        404,
      );
    }
    return { post, correction };
  }

  async getQuestion(
    postId: string,
    viewerUserId: string | null = null,
  ): Promise<CommunityPostResponse> {
    const post = await this.requireVisibleParent(postId, viewerUserId);
    if (post.postType !== 'QUESTION') {
      return correctionsFailure(
        'CORRECTIONS_PARENT_TYPE_INVALID',
        'The post is not a question',
        404,
      );
    }
    return post;
  }

  async createStructuredResponse(
    parentPostId: string,
    userId: string,
    input: CreateStructuredResponseInput,
  ): Promise<StructuredResponseResponse> {
    await this.requireActiveUser(userId);
    const parent = await this.requireVisibleParent(parentPostId, userId);
    if (parent.isOwner) {
      return correctionsFailure(
        'CORRECTIONS_SELF_RESPONSE',
        'You cannot respond to your own structured request',
        403,
      );
    }

    const responseKind = this.normalizePhase06(() => normalizeStructuredResponseKind(input.responseKind));
    let correction: CorrectionRequestRecord | null = null;
    if (parent.postType === 'CORRECTION_REQUEST') {
      correction = await this.repository.findCorrectionRequest(parentPostId);
      if (!correction) {
        return correctionsFailure(
          'CORRECTIONS_PARENT_UNAVAILABLE',
          'The correction request is not available',
          404,
        );
      }
    }
    if (
      (parent.postType === 'QUESTION' && responseKind !== 'QA_ANSWER') ||
      (parent.postType === 'CORRECTION_REQUEST' && responseKind !== 'CORRECTION_PROPOSAL')
    ) {
      return correctionsFailure(
        'CORRECTIONS_RESPONSE_KIND_INVALID',
        'The structured response kind does not match the parent',
      );
    }

    const correctedText = responseKind === 'CORRECTION_PROPOSAL'
      ? this.normalizePhase06(() => normalizePhase06Text(input.correctedText))
      : this.normalizePhase06(() => normalizePhase06OptionalText(input.correctedText));
    const answerText = responseKind === 'QA_ANSWER'
      ? this.normalizePhase06(() => normalizePhase06Text(input.answerText))
      : this.normalizePhase06(() => normalizePhase06OptionalText(input.answerText));
    const explanation = this.normalizePhase06(() => normalizePhase06OptionalText(
      input.explanation,
      MAX_PHASE06_EXPLANATION_CODE_POINTS,
    ));
    if (responseKind === 'CORRECTION_PROPOSAL' && answerText !== null) {
      return correctionsFailure(
        'CORRECTIONS_RESPONSE_KIND_INVALID',
        'A correction proposal cannot contain an answer',
      );
    }
    if (responseKind === 'QA_ANSWER' && correctedText !== null) {
      return correctionsFailure(
        'CORRECTIONS_RESPONSE_KIND_INVALID',
        'A Q&A answer cannot contain a corrected text',
      );
    }
    if (correction && correctedText === correction.originalText) {
      return correctionsFailure(
        'CORRECTIONS_UNCHANGED_CORRECTION',
        'The correction must change the original text',
      );
    }

    this.consumeRate('structured-response', userId, { limit: 20, windowMs: 15 * 60 * 1000 });
    try {
      const response = await this.repository.createStructuredResponse({
        parentPostId,
        parentPostType: parent.postType as Extract<CommunityPostType, 'QUESTION' | 'CORRECTION_REQUEST'>,
        authorUserId: userId,
        responseKind,
        correctedText,
        answerText,
        explanation,
        createdAt: new Date(),
      });
      const mapped = await this.toStructuredResponse(response, userId, parent);
      if (!mapped) {
        return correctionsFailure(
          'CORRECTIONS_RESPONSE_UNAVAILABLE',
          'The structured response is not available',
          404,
        );
      }
      return mapped;
    } catch (error) {
      if (error instanceof CorrectionsRepositoryConflictError) {
        return correctionsFailure(
          'CORRECTIONS_PARENT_UNAVAILABLE',
          'The structured response parent is not available',
          404,
        );
      }
      throw error;
    }
  }

  async listStructuredResponses(
    parentPostId: string,
    input: ListStructuredResponsesInput = {},
    viewerUserId: string | null = null,
  ): Promise<StructuredResponseListResponse> {
    const parent = await this.requireVisibleParent(parentPostId, viewerUserId);
    if (parent.postType !== 'QUESTION' && parent.postType !== 'CORRECTION_REQUEST') {
      return correctionsFailure(
        'CORRECTIONS_PARENT_TYPE_INVALID',
        'The post does not support structured responses',
        404,
      );
    }
    const page = await this.repository.listStructuredResponses({
      parentPostId,
      before: this.decodeCursor(input.cursor),
      limit: normalizeLimit(input.limit),
    });
    const items: StructuredResponseResponse[] = [];
    for (const response of page.items) {
      const mapped = await this.toStructuredResponse(response, viewerUserId, parent);
      if (mapped) items.push(mapped);
    }
    const cursorSource = page.items.at(-1);
    return {
      items,
      nextCursor: page.hasMore && cursorSource
        ? encodeCommunityCursor({ createdAt: cursorSource.createdAt, id: cursorSource.id })
        : null,
    };
  }

  async getStructuredResponse(
    responseId: string,
    viewerUserId: string | null = null,
  ): Promise<StructuredResponseResponse> {
    const response = await this.repository.findStructuredResponseById(responseId);
    if (!response || response.moderationState === 'HIDDEN') {
      return correctionsFailure(
        'CORRECTIONS_RESPONSE_UNAVAILABLE',
        'The structured response is not available',
        404,
      );
    }
    const parent = await this.requireVisibleParent(response.parentPostId, viewerUserId);
    const mapped = await this.toStructuredResponse(response, viewerUserId, parent);
    if (!mapped) {
      return correctionsFailure(
        'CORRECTIONS_RESPONSE_UNAVAILABLE',
        'The structured response is not available',
        404,
      );
    }
    return mapped;
  }

  async addStructuredResponseHelpfulVote(
    responseId: string,
    userId: string,
  ): Promise<StructuredResponseResponse> {
    await this.requireActiveUser(userId);
    const { response, parent } = await this.requireActiveStructuredResponse(responseId, userId);
    if (response.authorUserId === userId) {
      return correctionsFailure(
        'CORRECTIONS_SELF_VOTE',
        'You cannot mark your own structured response as helpful',
        403,
      );
    }
    this.consumeRate('structured-response-helpful', userId, { limit: 120, windowMs: 5 * 60 * 1000 });
    await this.repository.addStructuredResponseHelpfulVote(responseId, userId, new Date());
    const mapped = await this.toStructuredResponse(response, userId, parent);
    if (!mapped) {
      return correctionsFailure(
        'CORRECTIONS_RESPONSE_UNAVAILABLE',
        'The structured response is not available',
        404,
      );
    }
    return mapped;
  }

  async removeStructuredResponseHelpfulVote(
    responseId: string,
    userId: string,
  ): Promise<StructuredResponseResponse> {
    await this.requireActiveUser(userId);
    const { response, parent } = await this.requireActiveStructuredResponse(responseId, userId);
    if (response.authorUserId === userId) {
      return correctionsFailure(
        'CORRECTIONS_SELF_VOTE',
        'You cannot change a helpful vote on your own structured response',
        403,
      );
    }
    this.consumeRate('structured-response-helpful', userId, { limit: 120, windowMs: 5 * 60 * 1000 });
    await this.repository.removeStructuredResponseHelpfulVote(responseId, userId);
    const mapped = await this.toStructuredResponse(response, userId, parent);
    if (!mapped) {
      return correctionsFailure(
        'CORRECTIONS_RESPONSE_UNAVAILABLE',
        'The structured response is not available',
        404,
      );
    }
    return mapped;
  }

  async acceptStructuredResponse(
    parentPostId: string,
    responseId: string,
    userId: string,
  ): Promise<StructuredResponseResponse> {
    await this.requireActiveUser(userId);
    const parent = await this.requireVisibleParent(parentPostId, userId);
    if (!isStructuredResponseParent(parent.postType)) {
      return correctionsFailure(
        'CORRECTIONS_PARENT_TYPE_INVALID',
        'The post does not support structured responses',
        404,
      );
    }
    if (!parent.isOwner) {
      return correctionsFailure(
        'CORRECTIONS_ACCEPT_FORBIDDEN',
        'Only the requester can accept a structured response',
        403,
      );
    }
    const response = await this.repository.findStructuredResponseById(responseId);
    if (!response || response.moderationState !== 'ACTIVE' || response.parentPostId !== parentPostId) {
      return correctionsFailure(
        'CORRECTIONS_ACCEPT_INVALID',
        'The structured response is not available for this request',
        404,
      );
    }
    if (!responseKindMatchesParent(response.responseKind, parent.postType)) {
      return correctionsFailure(
        'CORRECTIONS_ACCEPT_INVALID',
        'The structured response kind does not match the request',
      );
    }
    const author = await this.identities.findUserById(response.authorUserId);
    if (!isActiveUser(author)) {
      return correctionsFailure(
        'CORRECTIONS_ACCEPT_INVALID',
        'The structured response is not available for this request',
        404,
      );
    }
    this.consumeRate('structured-response-acceptance', userId, { limit: 60, windowMs: 15 * 60 * 1000 });
    try {
      await this.repository.setStructuredResponseAcceptance({
        parentPostId,
        responseId,
        acceptedByUserId: userId,
        acceptedAt: new Date(),
      });
    } catch (error) {
      if (error instanceof CorrectionsRepositoryConflictError) {
        return correctionsFailure(
          'CORRECTIONS_ACCEPTANCE_CONFLICT',
          'The acceptance changed concurrently; please reload and try again',
          409,
        );
      }
      throw error;
    }
    const mapped = await this.toStructuredResponse(response, userId, parent);
    if (!mapped) {
      return correctionsFailure(
        'CORRECTIONS_RESPONSE_UNAVAILABLE',
        'The structured response is not available',
        404,
      );
    }
    return mapped;
  }

  async revokeStructuredResponseAcceptance(
    parentPostId: string,
    userId: string,
  ): Promise<StructuredResponseAcceptanceResponse> {
    await this.requireActiveUser(userId);
    const parent = await this.requireVisibleParent(parentPostId, userId);
    if (!isStructuredResponseParent(parent.postType)) {
      return correctionsFailure(
        'CORRECTIONS_PARENT_TYPE_INVALID',
        'The post does not support structured responses',
        404,
      );
    }
    if (!parent.isOwner) {
      return correctionsFailure(
        'CORRECTIONS_ACCEPT_FORBIDDEN',
        'Only the requester can revoke a structured response acceptance',
        403,
      );
    }
    this.consumeRate('structured-response-acceptance', userId, { limit: 60, windowMs: 15 * 60 * 1000 });
    const revoked = await this.repository.revokeStructuredResponseAcceptance(
      parentPostId,
      userId,
      new Date(),
    );
    return {
      parentPostId,
      responseId: revoked?.responseId ?? null,
      acceptedAt: revoked?.acceptedAt ?? null,
      revoked: Boolean(revoked),
    };
  }

  async nominateStructuredResponseAsLibraryCandidate(
    responseId: string,
    userId: string,
  ): Promise<LibraryCandidateResponse> {
    await this.requireActiveUser(userId);
    const { response, parent } = await this.requireActiveStructuredResponse(responseId, userId);
    if (!parent.isOwner) {
      return correctionsFailure(
        'CORRECTIONS_CANDIDATE_FORBIDDEN',
        'Only the requester can nominate a response for library review',
        403,
      );
    }
    if (parent.visibility !== 'PUBLIC') {
      return correctionsFailure(
        'CORRECTIONS_CANDIDATE_SOURCE_NOT_PUBLIC',
        'Only public requests can be nominated for library review',
        403,
      );
    }
    const interaction = await this.repository.getStructuredResponseInteraction(response.id, userId);
    if (interaction.acceptedResponseId !== response.id || !interaction.acceptedAcceptanceId) {
      return correctionsFailure(
        'CORRECTIONS_CANDIDATE_NOT_ACCEPTED',
        'Only the currently accepted response can be nominated',
        409,
      );
    }
    this.consumeRate('structured-response-candidate', userId, { limit: 20, windowMs: 15 * 60 * 1000 });
    try {
      const candidate = await this.repository.createLibraryCandidate({
        responseId,
        candidateCreatedByUserId: userId,
        createdAt: new Date(),
      });
      return toLibraryCandidateResponse(candidate);
    } catch (error) {
      if (error instanceof CorrectionsRepositoryConflictError) {
        return correctionsFailure(
          'CORRECTIONS_CANDIDATE_UNAVAILABLE',
          'The response is no longer available for library review',
          409,
        );
      }
      throw error;
    }
  }

  /** Internal Phase 08 handoff; no public candidate listing route is exposed. */
  async listPendingLibraryCandidates(limit = 100): Promise<LibraryCandidateRecord[]> {
    return this.repository.listPendingLibraryCandidates(Math.min(Math.max(limit, 1), 100));
  }

  /** Internal Phase 10/Phase 08 evidence seam; mutations remain in their owning services. */
  async listContributionEvents(query?: {
    parentPostId?: string;
    responseId?: string;
    candidateId?: string;
  }) {
    return this.repository.listContributionEvents(query);
  }

  private async requireVisibleParent(
    postId: string,
    viewerUserId: string | null,
  ): Promise<CommunityPostResponse> {
    try {
      return await this.community.getPost(postId, viewerUserId);
    } catch (error) {
      if (error instanceof CommunityFailure) {
        return correctionsFailure(
          'CORRECTIONS_PARENT_UNAVAILABLE',
          'The structured request is not available',
          404,
        );
      }
      throw error;
    }
  }

  private async toStructuredResponse(
    response: StructuredResponseRecord,
    viewerUserId: string | null = null,
    parent?: CommunityPostResponse,
  ): Promise<StructuredResponseResponse | null> {
    if (response.moderationState === 'HIDDEN') return null;
    const readableParent = parent ?? await this.requireVisibleParent(response.parentPostId, viewerUserId);
    const interaction = await this.repository.getStructuredResponseInteraction(
      response.id,
      viewerUserId,
    );
    const author = await this.identities.findUserById(response.authorUserId);
    const unavailable = response.moderationState === 'DELETED' || !isActiveUser(author);
    if (unavailable) {
      return {
        id: response.id,
        parentPostId: response.parentPostId,
        author: null,
        responseKind: response.responseKind,
        correctedText: null,
        answerText: null,
        explanation: null,
        createdAt: response.createdAt,
        updatedAt: response.updatedAt,
        editedAt: null,
        isDeleted: true,
        helpfulCount: 0,
        viewerHelpful: false,
        isAccepted: false,
        acceptedAt: null,
        libraryCandidateState: null,
        canAccept: false,
        canVote: false,
        canNominateCandidate: false,
      };
    }
    return {
      id: response.id,
      parentPostId: response.parentPostId,
      author: { id: author.id, displayName: author.displayName },
      responseKind: response.responseKind,
      correctedText: response.correctedText,
      answerText: response.answerText,
      explanation: response.explanation,
      createdAt: response.createdAt,
      updatedAt: response.updatedAt,
      editedAt: response.editedAt,
      isDeleted: false,
      helpfulCount: interaction.helpfulCount,
      viewerHelpful: interaction.viewerHelpful,
      isAccepted: interaction.acceptedResponseId === response.id,
      acceptedAt: interaction.acceptedResponseId === response.id ? interaction.acceptedAt : null,
      libraryCandidateState: readableParent.isOwner ? interaction.libraryCandidateState : null,
      canAccept: Boolean(viewerUserId && readableParent.isOwner),
      canVote: Boolean(viewerUserId && response.authorUserId !== viewerUserId),
      canNominateCandidate: Boolean(
        viewerUserId &&
        readableParent.isOwner &&
        readableParent.visibility === 'PUBLIC' &&
        interaction.acceptedResponseId === response.id &&
        interaction.libraryCandidateState === null,
      ),
    };
  }

  private async requireActiveStructuredResponse(
    responseId: string,
    viewerUserId: string,
  ): Promise<{ response: StructuredResponseRecord; parent: CommunityPostResponse }> {
    const response = await this.repository.findStructuredResponseById(responseId);
    if (!response || response.moderationState !== 'ACTIVE') {
      return correctionsFailure(
        'CORRECTIONS_RESPONSE_UNAVAILABLE',
        'The structured response is not available',
        404,
      );
    }
    const parent = await this.requireVisibleParent(response.parentPostId, viewerUserId);
    if (!isStructuredResponseParent(parent.postType) || !responseKindMatchesParent(response.responseKind, parent.postType)) {
      return correctionsFailure(
        'CORRECTIONS_RESPONSE_UNAVAILABLE',
        'The structured response is not available',
        404,
      );
    }
    return { response, parent };
  }

  private async requireActiveLanguage(input: unknown): Promise<string> {
    if (typeof input !== 'string') {
      return correctionsFailure('CORRECTIONS_LANGUAGE_INVALID', 'Language code is invalid');
    }
    const code = input.normalize('NFKC').trim().toLowerCase();
    if (!/^[a-z]{2,35}(?:-[a-z0-9]{2,8})*$/.test(code)) {
      return correctionsFailure('CORRECTIONS_LANGUAGE_INVALID', 'Language code is invalid');
    }
    const [language] = await this.profiles.findByCodes([code]);
    if (!language) {
      return correctionsFailure('CORRECTIONS_LANGUAGE_UNKNOWN', 'Language is not available');
    }
    if (!language.active) {
      return correctionsFailure('CORRECTIONS_LANGUAGE_INACTIVE', 'Language is not active');
    }
    return code;
  }

  private async requireActiveUser(userId: string): Promise<UserRecord> {
    const user = await this.identities.findUserById(userId);
    if (!isActiveUser(user)) {
      return correctionsFailure(
        'CORRECTIONS_AUTHOR_UNAVAILABLE',
        'Account is not available',
        403,
      );
    }
    return user;
  }

  private normalizePhase06<T>(callback: () => T): T {
    try {
      return callback();
    } catch (error) {
      if (error instanceof Phase06ValidationError) {
        return correctionsFailure(error.code, phase06Message(error.code));
      }
      throw error;
    }
  }

  private normalizeMetadata<T>(callback: () => T): T {
    try {
      return callback();
    } catch (error) {
      if (error instanceof CommunityValidationError) {
        return correctionsFailure('CORRECTIONS_METADATA_INVALID', 'Community metadata is invalid');
      }
      throw error;
    }
  }

  private decodeCursor(input: unknown): CommunityPostCursor | undefined {
    try {
      return decodeCommunityCursor(input);
    } catch (error) {
      if (error instanceof CommunityValidationError) {
        return correctionsFailure('CORRECTIONS_INVALID_CURSOR', 'Pagination cursor is invalid');
      }
      throw error;
    }
  }

  private consumeRate(
    operation: string,
    actorId: string,
    rule: { limit: number; windowMs: number },
  ): void {
    if (!this.rateLimiter.consume(operation, actorId, rule)) {
      correctionsFailure('CORRECTIONS_RATE_LIMITED', 'Please try again later', 429);
    }
  }
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    return correctionsFailure('CORRECTIONS_INVALID_LIMIT', 'Page size is invalid');
  }
  return limit;
}

function isActiveUser(user: UserRecord | null): user is UserRecord {
  return Boolean(user && user.status === 'ACTIVE' && user.emailVerifiedAt);
}

function isStructuredResponseParent(
  postType: CommunityPostType,
): postType is Extract<CommunityPostType, 'QUESTION' | 'CORRECTION_REQUEST'> {
  return postType === 'QUESTION' || postType === 'CORRECTION_REQUEST';
}

function responseKindMatchesParent(
  responseKind: StructuredResponseKind,
  postType: CommunityPostType,
): boolean {
  return (
    (responseKind === 'CORRECTION_PROPOSAL' && postType === 'CORRECTION_REQUEST') ||
    (responseKind === 'QA_ANSWER' && postType === 'QUESTION')
  );
}

function phase06Message(code: string): string {
  const messages: Record<string, string> = {
    PHASE06_TEXT_INVALID: 'Text is invalid',
    PHASE06_TEXT_EMPTY: 'Text cannot be empty',
    PHASE06_TEXT_TOO_LONG: 'Text is too long',
    CORRECTION_INTENT_INVALID: 'Correction intent is invalid',
    STRUCTURED_RESPONSE_KIND_INVALID: 'Structured response kind is invalid',
  };
  return messages[code] ?? 'Phase 06 input is invalid';
}

function toLibraryCandidateResponse(candidate: LibraryCandidateRecord): LibraryCandidateResponse {
  return {
    id: candidate.id,
    sourcePostId: candidate.sourcePostId,
    sourceResponseId: candidate.sourceResponseId,
    contributorUserId: candidate.contributorUserId,
    targetLanguageCode: candidate.targetLanguageCode,
    responseKind: candidate.responseKind,
    sourceText: candidate.sourceText,
    correctedText: candidate.correctedText,
    answerText: candidate.answerText,
    explanation: candidate.explanation,
    state: candidate.state,
    submittedForReview: true,
    createdAt: candidate.createdAt,
  };
}
