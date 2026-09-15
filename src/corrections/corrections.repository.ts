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
  StructuredResponseKind,
  StructuredResponseListQuery,
  StructuredResponseRecord,
} from './corrections.types';

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
  setStructuredResponseModerationState(
    id: string,
    moderationState: CommunityModerationState,
    now: Date,
  ): Promise<StructuredResponseRecord | null>;
}

export class InMemoryCorrectionsRepository implements CorrectionsRepository {
  private readonly correctionRequests = new Map<string, CorrectionRequestRecord>();
  private readonly responses = new Map<string, StructuredResponseRecord>();

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

  async setStructuredResponseModerationState(
    id: string,
    moderationState: CommunityModerationState,
    now: Date,
  ): Promise<StructuredResponseRecord | null> {
    const response = this.responses.get(id);
    if (!response) return null;
    response.moderationState = moderationState;
    response.updatedAt = new Date(now);
    if (moderationState === 'DELETED' && !response.deletedAt) {
      response.deletedAt = new Date(now);
    }
    return cloneResponse(response);
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
