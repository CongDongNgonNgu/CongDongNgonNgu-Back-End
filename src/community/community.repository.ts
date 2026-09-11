import { randomUUID } from 'node:crypto';
import type {
  CommunityCefrLevel,
  CommunityCommentRecord,
  CommunityCommentThreadRecord,
  CommunityInteractionSummary,
  CommunityListResult,
  CommunityModerationState,
  CommunityPostCursor,
  CommunityPostRecord,
  CommunityPostType,
  CommunityReactionType,
  CommunityReportInput,
  CommunityVisibility,
} from './community.types';

export const COMMUNITY_REPOSITORY = 'COMMUNITY_REPOSITORY';

export class CommunityRepositoryConflictError extends Error {
  constructor(message = 'Community record conflicts with existing data') {
    super(message);
    this.name = 'CommunityRepositoryConflictError';
  }
}

export interface CreateCommunityPostInput {
  authorUserId: string;
  targetLanguageCode: string;
  postType: CommunityPostType;
  content: string;
  cefrLevel: CommunityCefrLevel | null;
  topic: string | null;
  visibility: CommunityVisibility;
  createdAt: Date;
}

export interface UpdateCommunityPostInput {
  targetLanguageCode?: string;
  postType?: CommunityPostType;
  content?: string;
  cefrLevel?: CommunityCefrLevel | null;
  topic?: string | null;
  visibility?: CommunityVisibility;
  updatedAt: Date;
  editedAt: Date;
}

export interface CommunityPostListQuery {
  languageCode?: string;
  before?: CommunityPostCursor;
  limit: number;
}

export interface CreateCommunityCommentInput {
  postId: string;
  authorUserId: string;
  parentCommentId: string | null;
  depth: 0 | 1;
  content: string;
  createdAt: Date;
}

export interface UpdateCommunityCommentInput {
  content: string;
  updatedAt: Date;
  editedAt: Date;
}

export interface CommunityCommentListQuery {
  postId: string;
  before?: CommunityPostCursor;
  limit: number;
  replyLimit: number;
}

export interface CommunityRepository {
  createPost(input: CreateCommunityPostInput): Promise<CommunityPostRecord>;
  findPostById(id: string): Promise<CommunityPostRecord | null>;
  updatePost(id: string, input: UpdateCommunityPostInput): Promise<CommunityPostRecord | null>;
  softDeletePost(id: string, deletedByUserId: string, now: Date): Promise<CommunityPostRecord | null>;
  setPostModerationState(
    id: string,
    moderationState: CommunityModerationState,
    now: Date,
  ): Promise<CommunityPostRecord | null>;
  listPosts(query: CommunityPostListQuery): Promise<CommunityListResult<CommunityPostRecord>>;
  listSavedPosts(
    userId: string,
    query: CommunityPostListQuery,
  ): Promise<CommunityListResult<CommunityPostRecord>>;
  getPostInteractionSummary(
    postId: string,
    viewerUserId: string | null,
  ): Promise<CommunityInteractionSummary>;

  createComment(input: CreateCommunityCommentInput): Promise<CommunityCommentRecord>;
  findCommentById(id: string): Promise<CommunityCommentRecord | null>;
  updateComment(id: string, input: UpdateCommunityCommentInput): Promise<CommunityCommentRecord | null>;
  softDeleteComment(id: string, deletedByUserId: string, now: Date): Promise<CommunityCommentRecord | null>;
  listCommentThreads(
    query: CommunityCommentListQuery,
  ): Promise<CommunityListResult<CommunityCommentThreadRecord>>;

  addReaction(userId: string, postId: string, reactionType: CommunityReactionType, now: Date): Promise<void>;
  removeReaction(userId: string, postId: string, reactionType: CommunityReactionType): Promise<void>;
  savePost(userId: string, postId: string, now: Date): Promise<void>;
  unsavePost(userId: string, postId: string): Promise<void>;
  createReport(input: CommunityReportInput): Promise<void>;
}

export class InMemoryCommunityRepository implements CommunityRepository {
  private readonly posts = new Map<string, CommunityPostRecord>();
  private readonly comments = new Map<string, CommunityCommentRecord>();
  private readonly reactions = new Map<string, Date>();
  private readonly savedPosts = new Map<string, Date>();
  private readonly reports = new Set<string>();

  async createPost(input: CreateCommunityPostInput): Promise<CommunityPostRecord> {
    const record: CommunityPostRecord = {
      id: randomUUID(),
      authorUserId: input.authorUserId,
      targetLanguageCode: input.targetLanguageCode,
      postType: input.postType,
      content: input.content,
      cefrLevel: input.cefrLevel,
      topic: input.topic,
      visibility: input.visibility,
      moderationState: 'ACTIVE',
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.createdAt),
      editedAt: null,
      deletedAt: null,
      deletedByUserId: null,
    };
    this.posts.set(record.id, record);
    return clonePost(record);
  }

  async findPostById(id: string): Promise<CommunityPostRecord | null> {
    const post = this.posts.get(id);
    return post ? clonePost(post) : null;
  }

  async updatePost(id: string, input: UpdateCommunityPostInput): Promise<CommunityPostRecord | null> {
    const post = this.posts.get(id);
    if (!post) return null;
    if (input.targetLanguageCode !== undefined) post.targetLanguageCode = input.targetLanguageCode;
    if (input.postType !== undefined) post.postType = input.postType;
    if (input.content !== undefined) post.content = input.content;
    if (input.cefrLevel !== undefined) post.cefrLevel = input.cefrLevel;
    if (input.topic !== undefined) post.topic = input.topic;
    if (input.visibility !== undefined) post.visibility = input.visibility;
    post.updatedAt = new Date(input.updatedAt);
    post.editedAt = new Date(input.editedAt);
    return clonePost(post);
  }

  async softDeletePost(
    id: string,
    deletedByUserId: string,
    now: Date,
  ): Promise<CommunityPostRecord | null> {
    const post = this.posts.get(id);
    if (!post) return null;
    if (post.moderationState !== 'DELETED') {
      post.moderationState = 'DELETED';
      post.deletedAt = new Date(now);
      post.deletedByUserId = deletedByUserId;
      post.updatedAt = new Date(now);
    }
    return clonePost(post);
  }

  async setPostModerationState(
    id: string,
    moderationState: CommunityModerationState,
    now: Date,
  ): Promise<CommunityPostRecord | null> {
    const post = this.posts.get(id);
    if (!post) return null;
    post.moderationState = moderationState;
    post.updatedAt = new Date(now);
    if (moderationState === 'DELETED') {
      post.deletedAt = new Date(now);
    }
    return clonePost(post);
  }

  async listPosts(query: CommunityPostListQuery): Promise<CommunityListResult<CommunityPostRecord>> {
    const items = [...this.posts.values()]
      .filter((post) => (
        post.visibility === 'PUBLIC' &&
        post.moderationState === 'ACTIVE' &&
        (!query.languageCode || post.targetLanguageCode === query.languageCode) &&
        isBeforeCursor(post, query.before)
      ))
      .sort(compareNewestFirst);
    return page(items, query.limit);
  }

  async listSavedPosts(
    userId: string,
    query: CommunityPostListQuery,
  ): Promise<CommunityListResult<CommunityPostRecord>> {
    const items = [...this.posts.values()]
      .filter((post) => (
        post.moderationState === 'ACTIVE' &&
        (post.visibility === 'PUBLIC' || post.authorUserId === userId) &&
        this.savedPosts.has(saveKey(userId, post.id)) &&
        isBeforeCursor(post, query.before)
      ))
      .sort(compareNewestFirst);
    return page(items, query.limit);
  }

  async getPostInteractionSummary(
    postId: string,
    viewerUserId: string | null,
  ): Promise<CommunityInteractionSummary> {
    let helpfulCount = 0;
    for (const key of this.reactions.keys()) {
      const [, reactionPostId, reactionType] = key.split(':');
      if (reactionPostId === postId && reactionType === 'HELPFUL') helpfulCount += 1;
    }
    const commentCount = [...this.comments.values()]
      .filter((comment) => comment.postId === postId && comment.moderationState === 'ACTIVE')
      .length;
    return {
      helpfulCount,
      viewerReacted: viewerUserId
        ? this.reactions.has(reactionKey(viewerUserId, postId, 'HELPFUL'))
        : false,
      commentCount,
      viewerSaved: viewerUserId ? this.savedPosts.has(saveKey(viewerUserId, postId)) : false,
    };
  }

  async createComment(input: CreateCommunityCommentInput): Promise<CommunityCommentRecord> {
    const record: CommunityCommentRecord = {
      id: randomUUID(),
      postId: input.postId,
      authorUserId: input.authorUserId,
      parentCommentId: input.parentCommentId,
      depth: input.depth,
      content: input.content,
      moderationState: 'ACTIVE',
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.createdAt),
      editedAt: null,
      deletedAt: null,
      deletedByUserId: null,
    };
    this.comments.set(record.id, record);
    return cloneComment(record);
  }

  async findCommentById(id: string): Promise<CommunityCommentRecord | null> {
    const comment = this.comments.get(id);
    return comment ? cloneComment(comment) : null;
  }

  async updateComment(
    id: string,
    input: UpdateCommunityCommentInput,
  ): Promise<CommunityCommentRecord | null> {
    const comment = this.comments.get(id);
    if (!comment) return null;
    comment.content = input.content;
    comment.updatedAt = new Date(input.updatedAt);
    comment.editedAt = new Date(input.editedAt);
    return cloneComment(comment);
  }

  async softDeleteComment(
    id: string,
    deletedByUserId: string,
    now: Date,
  ): Promise<CommunityCommentRecord | null> {
    const comment = this.comments.get(id);
    if (!comment) return null;
    if (comment.moderationState !== 'DELETED') {
      comment.moderationState = 'DELETED';
      comment.deletedAt = new Date(now);
      comment.deletedByUserId = deletedByUserId;
      comment.updatedAt = new Date(now);
    }
    return cloneComment(comment);
  }

  async listCommentThreads(
    query: CommunityCommentListQuery,
  ): Promise<CommunityListResult<CommunityCommentThreadRecord>> {
    const topLevel = [...this.comments.values()]
      .filter((comment) => (
        comment.postId === query.postId &&
        comment.parentCommentId === null &&
        comment.moderationState !== 'HIDDEN' &&
        isBeforeCursor(comment, query.before)
      ))
      .sort(compareNewestFirst);
    const pageResult = page(topLevel, query.limit);
    const items = pageResult.items.map((comment) => {
      const allReplies = [...this.comments.values()]
        .filter((reply) => (
          reply.parentCommentId === comment.id &&
          reply.moderationState !== 'HIDDEN'
        ))
        .sort(compareOldestFirst);
      return {
        comment: cloneComment(comment),
        replies: allReplies.slice(0, query.replyLimit).map(cloneComment),
        hasMoreReplies: allReplies.length > query.replyLimit,
      };
    });
    return { items, hasMore: pageResult.hasMore };
  }

  async addReaction(
    userId: string,
    postId: string,
    reactionType: CommunityReactionType,
    now: Date,
  ): Promise<void> {
    const key = reactionKey(userId, postId, reactionType);
    if (!this.reactions.has(key)) this.reactions.set(key, new Date(now));
  }

  async removeReaction(userId: string, postId: string, reactionType: CommunityReactionType): Promise<void> {
    this.reactions.delete(reactionKey(userId, postId, reactionType));
  }

  async savePost(userId: string, postId: string, now: Date): Promise<void> {
    const key = saveKey(userId, postId);
    if (!this.savedPosts.has(key)) this.savedPosts.set(key, new Date(now));
  }

  async unsavePost(userId: string, postId: string): Promise<void> {
    this.savedPosts.delete(saveKey(userId, postId));
  }

  async createReport(input: CommunityReportInput): Promise<void> {
    const key = [
      input.reporterUserId,
      input.targetType,
      input.targetId,
      input.category,
    ].join(':');
    this.reports.add(key);
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

function compareOldestFirst(
  left: { createdAt: Date; id: string },
  right: { createdAt: Date; id: string },
): number {
  const timeDifference = left.createdAt.getTime() - right.createdAt.getTime();
  if (timeDifference !== 0) return timeDifference;
  return left.id.localeCompare(right.id);
}

function reactionKey(userId: string, postId: string, reactionType: string): string {
  return userId + ':' + postId + ':' + reactionType;
}

function saveKey(userId: string, postId: string): string {
  return userId + ':' + postId;
}

function clonePost(post: CommunityPostRecord): CommunityPostRecord {
  return {
    ...post,
    createdAt: new Date(post.createdAt),
    updatedAt: new Date(post.updatedAt),
    editedAt: post.editedAt ? new Date(post.editedAt) : null,
    deletedAt: post.deletedAt ? new Date(post.deletedAt) : null,
  };
}

function cloneComment(comment: CommunityCommentRecord): CommunityCommentRecord {
  return {
    ...comment,
    createdAt: new Date(comment.createdAt),
    updatedAt: new Date(comment.updatedAt),
    editedAt: comment.editedAt ? new Date(comment.editedAt) : null,
    deletedAt: comment.deletedAt ? new Date(comment.deletedAt) : null,
  };
}
