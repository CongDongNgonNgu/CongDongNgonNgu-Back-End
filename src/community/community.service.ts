import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY_REPOSITORY } from '../identity/identity.module';
import type { IdentityRepository } from '../identity/identity.repository';
import type { UserRecord } from '../identity/identity.types';
import { PROFILE_REPOSITORY } from '../profile/profile.repository';
import type { LanguageCatalogRecord } from '../profile/profile.types';
import type { ProfileRepository } from '../profile/profile.repository';
import {
  MAX_COMMENT_CONTENT_LENGTH,
  MAX_POST_CONTENT_LENGTH,
  CommunityValidationError,
  normalizeCefrLevel,
  normalizeCommunityContent,
  normalizeCommunityTopic,
  normalizePostType,
  normalizeOptionalReportDetails,
  normalizeReactionType,
  normalizeReportCategory,
  normalizeReportTargetType,
  normalizeVisibility,
} from './community.normalization';
import { communityFailure } from './community.errors';
import {
  decodeCommunityCursor,
  encodeCommunityCursor,
} from './community.pagination';
import {
  COMMUNITY_REPOSITORY,
  CommunityRepositoryConflictError,
  type CommunityCommentListQuery,
  type CreateCommunityCommentInput,
  type CommunityPostListQuery,
  type CommunityRepository,
  type CreateCommunityPostInput,
  type UpdateCommunityPostInput,
} from './community.repository';
import type {
  CommunityCommentRecord,
  CommunityCommentThreadRecord,
  CommunityPostRecord,
  CommunityPostCursor,
  CommunityReactionType,
  CommunityReportTargetType,
  CommunityVisibility,
} from './community.types';
import type {
  CreateCommentDto,
  CreatePostDto,
  ListCommentsQueryDto,
  ListPostsQueryDto,
  ReactionDto,
  ReportDto,
  SavedPostsQueryDto,
  UpdateCommentDto,
  UpdatePostDto,
} from './community.dto';
import { CommunityRateLimiter } from './community.rate-limiter';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export interface CommunityAuthorResponse {
  id: string;
  displayName: string;
}

export interface CommunityLanguageResponse {
  code: string;
  slug: string;
  nativeName: string;
  englishName: string;
  vietnameseName: string;
  direction: 'ltr' | 'rtl';
}

export interface CommunityPostResponse {
  id: string;
  author: CommunityAuthorResponse;
  targetLanguage: CommunityLanguageResponse;
  postType: CommunityPostRecord['postType'];
  content: string;
  cefrLevel: CommunityPostRecord['cefrLevel'];
  topic: string | null;
  visibility: CommunityVisibility;
  createdAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
  canonicalPath: string | null;
  isShareable: boolean;
  isOwner: boolean;
  helpfulCount: number;
  viewerReacted: boolean;
  commentCount: number;
  isSaved: boolean;
}

export interface CommunityPostListResponse {
  items: CommunityPostResponse[];
  nextCursor: string | null;
}

export interface CommunityCommentResponse {
  id: string;
  author: CommunityAuthorResponse | null;
  parentCommentId: string | null;
  depth: 0 | 1;
  content: string | null;
  createdAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
  isDeleted: boolean;
}

export interface CommunityCommentThreadResponse extends CommunityCommentResponse {
  replies: CommunityCommentResponse[];
  hasMoreReplies: boolean;
}

export interface CommunityCommentListResponse {
  items: CommunityCommentThreadResponse[];
  nextCursor: string | null;
}

export interface CommunityReactionResponse {
  postId: string;
  type: CommunityReactionType;
  reacted: boolean;
  helpfulCount: number;
}

export interface CommunitySaveResponse {
  postId: string;
  saved: boolean;
}

export interface CommunityShareResponse {
  postId: string;
  canonicalPath: string;
  isShareable: true;
}

@Injectable()
export class CommunityService {
  constructor(
    @Inject(COMMUNITY_REPOSITORY) private readonly repository: CommunityRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository,
    private readonly rateLimiter: CommunityRateLimiter,
  ) {}

  async createPost(userId: string, input: CreatePostDto): Promise<CommunityPostResponse> {
    await this.requireActiveUser(userId);
    const normalized = await this.normalizePostInput(input, true);
    this.consumeRate('post', userId, { limit: 10, windowMs: 15 * 60 * 1000 });
    let post: CommunityPostRecord;
    try {
      post = await this.repository.createPost({
        ...normalized,
        authorUserId: userId,
        createdAt: new Date(),
      });
    } catch (error) {
      if (error instanceof CommunityRepositoryConflictError) {
        return communityFailure(
          'COMMUNITY_LANGUAGE_UNAVAILABLE',
          'Language is not available',
          400,
        );
      }
      throw error;
    }
    return this.toPostResponseOrThrow(post, userId);
  }

  async listPosts(
    input: ListPostsQueryDto = {},
    viewerUserId: string | null = null,
  ): Promise<CommunityPostListResponse> {
    const languageCode = input.languageCode === undefined
      ? undefined
      : await this.requireActiveLanguage(input.languageCode);
    const query: CommunityPostListQuery = {
      languageCode,
      before: this.decodeCursor(input.cursor),
      limit: normalizeLimit(input.limit),
    };
    const page = await this.repository.listPosts(query);
    const items: CommunityPostResponse[] = [];
    for (const post of page.items) {
      const response = await this.toPostResponse(post, viewerUserId);
      if (response) items.push(response);
    }
    const cursorSource = page.items.at(-1);
    return {
      items,
      nextCursor: page.hasMore && cursorSource
        ? encodeCommunityCursor({ createdAt: cursorSource.createdAt, id: cursorSource.id })
        : null,
    };
  }

  async getPost(id: string, viewerUserId: string | null = null): Promise<CommunityPostResponse> {
    const post = await this.repository.findPostById(id);
    if (!post || post.moderationState !== 'ACTIVE') {
      return communityFailure('COMMUNITY_POST_UNAVAILABLE', 'Post is not available', 404);
    }
    if (post.visibility === 'PRIVATE' && post.authorUserId !== viewerUserId) {
      return communityFailure('COMMUNITY_POST_UNAVAILABLE', 'Post is not available', 404);
    }
    return this.toPostResponseOrThrow(post, viewerUserId);
  }

  async getShareLink(id: string): Promise<CommunityShareResponse> {
    const post = await this.repository.findPostById(id);
    if (!post || post.moderationState !== 'ACTIVE' || post.visibility !== 'PUBLIC') {
      return communityFailure('COMMUNITY_POST_UNAVAILABLE', 'Post is not available', 404);
    }
    const [language] = await this.profiles.findByCodes([post.targetLanguageCode]);
    const author = await this.identities.findUserById(post.authorUserId);
    if (!language?.active || !isActiveUser(author)) {
      return communityFailure('COMMUNITY_POST_UNAVAILABLE', 'Post is not available', 404);
    }
    return {
      postId: post.id,
      canonicalPath: '/community/posts/' + post.id,
      isShareable: true,
    };
  }

  async updatePost(
    id: string,
    userId: string,
    input: UpdatePostDto,
  ): Promise<CommunityPostResponse> {
    const current = await this.requireMutablePost(id, userId);
    const normalized = await this.normalizePostUpdate(input);
    if (Object.keys(normalized).length === 0) {
      return communityFailure('COMMUNITY_UPDATE_EMPTY', 'At least one post field must be changed');
    }
    const now = new Date();
    const post = await this.repository.updatePost(id, {
      ...normalized,
      updatedAt: now,
      editedAt: now,
    });
    if (!post) {
      return communityFailure('COMMUNITY_POST_UNAVAILABLE', 'Post is not available', 404);
    }
    void current;
    return this.toPostResponseOrThrow(post, userId);
  }

  async deletePost(id: string, userId: string): Promise<{ deleted: true }> {
    const current = await this.repository.findPostById(id);
    if (!current) return communityFailure('COMMUNITY_POST_NOT_FOUND', 'Post was not found', 404);
    if (current.moderationState === 'DELETED' && current.authorUserId === userId) {
      return { deleted: true };
    }
    if (current.moderationState !== 'ACTIVE') {
      return communityFailure('COMMUNITY_POST_UNAVAILABLE', 'Post is not available', 404);
    }
    if (current.visibility === 'PRIVATE' && current.authorUserId !== userId) {
      return communityFailure('COMMUNITY_POST_UNAVAILABLE', 'Post is not available', 404);
    }
    if (current.authorUserId !== userId) {
      return communityFailure('COMMUNITY_FORBIDDEN', 'You do not own this post', 403);
    }
    await this.repository.softDeletePost(id, userId, new Date());
    return { deleted: true };
  }

  async createComment(
    postId: string,
    userId: string,
    input: CreateCommentDto,
  ): Promise<CommunityCommentResponse> {
    await this.requireActiveUser(userId);
    await this.requireReadablePost(postId, userId);
    const content = this.normalize(() => normalizeCommunityContent(
      input.content,
      MAX_COMMENT_CONTENT_LENGTH,
    ));
    let parentCommentId: string | null = null;
    let depth: 0 | 1 = 0;
    if (input.parentCommentId) {
      const parent = await this.repository.findCommentById(input.parentCommentId);
      if (
        !parent ||
        parent.postId !== postId ||
        parent.moderationState !== 'ACTIVE'
      ) {
        return communityFailure(
          'COMMUNITY_COMMENT_UNAVAILABLE',
          'Comment is not available',
          404,
        );
      }
      if (parent.depth === 1 || parent.parentCommentId !== null) {
        return communityFailure(
          'COMMUNITY_COMMENT_DEPTH_EXCEEDED',
          'Replies can only be one level deep',
        );
      }
      parentCommentId = parent.id;
      depth = 1;
    }
    this.consumeRate('comment', userId, { limit: 60, windowMs: 15 * 60 * 1000 });
    const comment = await this.repository.createComment({
      postId,
      authorUserId: userId,
      parentCommentId,
      depth,
      content,
      createdAt: new Date(),
    });
    return this.toCommentResponseOrThrow(comment);
  }

  async listComments(
    postId: string,
    input: ListCommentsQueryDto = {},
    viewerUserId: string | null = null,
  ): Promise<CommunityCommentListResponse> {
    await this.requireReadablePost(postId, viewerUserId);
    const query: CommunityCommentListQuery = {
      postId,
      before: this.decodeCursor(input.cursor),
      limit: normalizeBoundedLimit(input.limit, 20, 20),
      replyLimit: 20,
    };
    const page = await this.repository.listCommentThreads(query);
    const items: CommunityCommentThreadResponse[] = [];
    for (const thread of page.items) {
      const comment = await this.toCommentResponse(thread.comment);
      if (!comment) continue;
      const replies: CommunityCommentResponse[] = [];
      for (const reply of thread.replies) {
        const response = await this.toCommentResponse(reply);
        if (response) replies.push(response);
      }
      if (comment.isDeleted && replies.length === 0) continue;
      items.push({
        ...comment,
        replies,
        hasMoreReplies: thread.hasMoreReplies,
      });
    }
    const cursorSource = page.items.at(-1)?.comment;
    return {
      items,
      nextCursor: page.hasMore && cursorSource
        ? encodeCommunityCursor({ createdAt: cursorSource.createdAt, id: cursorSource.id })
        : null,
    };
  }

  async updateComment(
    id: string,
    userId: string,
    input: UpdateCommentDto,
  ): Promise<CommunityCommentResponse> {
    const current = await this.requireMutableComment(id, userId);
    const content = this.normalize(() => normalizeCommunityContent(
      input.content,
      MAX_COMMENT_CONTENT_LENGTH,
    ));
    this.consumeRate('comment-edit', userId, { limit: 60, windowMs: 15 * 60 * 1000 });
    const now = new Date();
    const comment = await this.repository.updateComment(id, {
      content,
      updatedAt: now,
      editedAt: now,
    });
    if (!comment) {
      return communityFailure(
        'COMMUNITY_COMMENT_UNAVAILABLE',
        'Comment is not available',
        404,
      );
    }
    void current;
    return this.toCommentResponseOrThrow(comment);
  }

  async deleteComment(id: string, userId: string): Promise<{ deleted: true }> {
    await this.requireMutableComment(id, userId);
    await this.repository.softDeleteComment(id, userId, new Date());
    return { deleted: true };
  }

  async addReaction(
    postId: string,
    userId: string,
    input: ReactionDto,
  ): Promise<CommunityReactionResponse> {
    await this.requireActiveUser(userId);
    const post = await this.requireReadablePost(postId, userId);
    const type = this.normalize(() => normalizeReactionType(input.type));
    this.consumeRate('reaction', userId, { limit: 120, windowMs: 5 * 60 * 1000 });
    await this.repository.addReaction(userId, post.id, type, new Date());
    const summary = await this.repository.getPostInteractionSummary(post.id, userId);
    return {
      postId: post.id,
      type,
      reacted: summary.viewerReacted,
      helpfulCount: summary.helpfulCount,
    };
  }

  async removeReaction(
    postId: string,
    userId: string,
    typeInput: string,
  ): Promise<CommunityReactionResponse> {
    await this.requireActiveUser(userId);
    const post = await this.requireReadablePost(postId, userId);
    const type = this.normalize(() => normalizeReactionType(typeInput));
    this.consumeRate('reaction', userId, { limit: 120, windowMs: 5 * 60 * 1000 });
    await this.repository.removeReaction(userId, post.id, type);
    const summary = await this.repository.getPostInteractionSummary(post.id, userId);
    return {
      postId: post.id,
      type,
      reacted: summary.viewerReacted,
      helpfulCount: summary.helpfulCount,
    };
  }

  async savePost(postId: string, userId: string): Promise<CommunitySaveResponse> {
    await this.requireActiveUser(userId);
    const post = await this.requireReadablePost(postId, userId);
    this.consumeRate('save', userId, { limit: 120, windowMs: 15 * 60 * 1000 });
    await this.repository.savePost(userId, post.id, new Date());
    return { postId: post.id, saved: true };
  }

  async unsavePost(postId: string, userId: string): Promise<CommunitySaveResponse> {
    await this.requireActiveUser(userId);
    const post = await this.requireReadablePost(postId, userId);
    this.consumeRate('save', userId, { limit: 120, windowMs: 15 * 60 * 1000 });
    await this.repository.unsavePost(userId, post.id);
    return { postId: post.id, saved: false };
  }

  async listSavedPosts(
    input: SavedPostsQueryDto = {},
    viewerUserId: string,
  ): Promise<CommunityPostListResponse> {
    await this.requireActiveUser(viewerUserId);
    const page = await this.repository.listSavedPosts(viewerUserId, {
      before: this.decodeCursor(input.cursor),
      limit: normalizeBoundedLimit(input.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    });
    const items: CommunityPostResponse[] = [];
    for (const post of page.items) {
      const response = await this.toPostResponse(post, viewerUserId);
      if (response) items.push(response);
    }
    const cursorSource = page.items.at(-1);
    return {
      items,
      nextCursor: page.hasMore && cursorSource
        ? encodeCommunityCursor({ createdAt: cursorSource.createdAt, id: cursorSource.id })
        : null,
    };
  }

  async report(
    userId: string,
    input: ReportDto,
  ): Promise<{ submitted: true }> {
    await this.requireActiveUser(userId);
    const targetType = this.normalize(() => normalizeReportTargetType(input.targetType));
    const category = this.normalize(() => normalizeReportCategory(input.category));
    const details = this.normalize(() => normalizeOptionalReportDetails(input.details));
    this.consumeRate('report', userId, { limit: 10, windowMs: 60 * 60 * 1000 });
    if (await this.isReportTargetVisible(targetType, input.targetId, userId)) {
      await this.repository.createReport({
        reporterUserId: userId,
        targetType,
        targetId: input.targetId,
        category,
        details,
        createdAt: new Date(),
      });
    }
    return { submitted: true };
  }

  private async requireMutablePost(id: string, userId: string): Promise<CommunityPostRecord> {
    const post = await this.repository.findPostById(id);
    if (!post || post.moderationState !== 'ACTIVE') {
      return communityFailure('COMMUNITY_POST_UNAVAILABLE', 'Post is not available', 404);
    }
    if (post.visibility === 'PRIVATE' && post.authorUserId !== userId) {
      return communityFailure('COMMUNITY_POST_UNAVAILABLE', 'Post is not available', 404);
    }
    if (post.authorUserId !== userId) {
      return communityFailure('COMMUNITY_FORBIDDEN', 'You do not own this post', 403);
    }
    return post;
  }

  private async requireReadablePost(
    id: string,
    viewerUserId: string | null,
  ): Promise<CommunityPostRecord> {
    const post = await this.repository.findPostById(id);
    if (
      !post ||
      post.moderationState !== 'ACTIVE' ||
      (post.visibility === 'PRIVATE' && post.authorUserId !== viewerUserId)
    ) {
      return communityFailure('COMMUNITY_POST_UNAVAILABLE', 'Post is not available', 404);
    }
    return post;
  }

  private async requireMutableComment(
    id: string,
    userId: string,
  ): Promise<CommunityCommentRecord> {
    const comment = await this.repository.findCommentById(id);
    if (!comment || comment.moderationState !== 'ACTIVE') {
      return communityFailure('COMMUNITY_COMMENT_UNAVAILABLE', 'Comment is not available', 404);
    }
    await this.requireReadablePost(comment.postId, userId);
    if (comment.authorUserId !== userId) {
      return communityFailure('COMMUNITY_FORBIDDEN', 'You do not own this comment', 403);
    }
    return comment;
  }

  private async isReportTargetVisible(
    targetType: CommunityReportTargetType,
    targetId: string,
    viewerUserId: string,
  ): Promise<boolean> {
    if (targetType === 'POST') {
      const post = await this.repository.findPostById(targetId);
      return Boolean(
        post &&
        post.moderationState === 'ACTIVE' &&
        (post.visibility === 'PUBLIC' || post.authorUserId === viewerUserId),
      );
    }
    const comment = await this.repository.findCommentById(targetId);
    if (!comment || comment.moderationState !== 'ACTIVE') return false;
    const post = await this.repository.findPostById(comment.postId);
    return Boolean(
      post &&
      post.moderationState === 'ACTIVE' &&
      (post.visibility === 'PUBLIC' || post.authorUserId === viewerUserId),
    );
  }

  private async normalizePostInput(
    input: CreatePostDto,
    requireVisibility: boolean,
  ): Promise<CreateCommunityPostInput> {
    const postType = this.normalize(() => normalizePostType(input.postType));
    const targetLanguageCode = await this.requireActiveLanguage(input.languageCode);
    const content = this.normalize(() => normalizeCommunityContent(
      input.content,
      MAX_POST_CONTENT_LENGTH,
    ));
    const cefrLevel = this.normalize(() => normalizeCefrLevel(input.cefrLevel));
    const topic = this.normalize(() => normalizeCommunityTopic(input.topic));
    const visibility = requireVisibility
      ? this.normalize(() => normalizeVisibility(input.visibility))
      : 'PUBLIC';
    return {
      authorUserId: '',
      targetLanguageCode,
      postType,
      content,
      cefrLevel,
      topic,
      visibility,
      createdAt: new Date(),
    };
  }

  private async normalizePostUpdate(input: UpdatePostDto): Promise<UpdateCommunityPostInput> {
    const normalized: Partial<UpdateCommunityPostInput> = {};
    if (input.postType !== undefined) normalized.postType = this.normalize(() => normalizePostType(input.postType));
    if (input.languageCode !== undefined) {
      normalized.targetLanguageCode = await this.requireActiveLanguage(input.languageCode);
    }
    if (input.content !== undefined) {
      normalized.content = this.normalize(() => normalizeCommunityContent(
        input.content,
        MAX_POST_CONTENT_LENGTH,
      ));
    }
    if (input.cefrLevel !== undefined) {
      normalized.cefrLevel = this.normalize(() => normalizeCefrLevel(input.cefrLevel));
    }
    if (input.topic !== undefined) {
      normalized.topic = this.normalize(() => normalizeCommunityTopic(input.topic));
    }
    if (input.visibility !== undefined) {
      normalized.visibility = this.normalize(() => normalizeVisibility(input.visibility));
    }
    return normalized as UpdateCommunityPostInput;
  }

  private async toCommentResponseOrThrow(
    comment: CommunityCommentRecord,
  ): Promise<CommunityCommentResponse> {
    const response = await this.toCommentResponse(comment);
    if (!response) {
      return communityFailure('COMMUNITY_COMMENT_UNAVAILABLE', 'Comment is not available', 404);
    }
    return response;
  }

  private async toCommentResponse(
    comment: CommunityCommentRecord,
  ): Promise<CommunityCommentResponse | null> {
    if (comment.moderationState === 'HIDDEN') return null;
    const base = {
      id: comment.id,
      parentCommentId: comment.parentCommentId,
      depth: comment.depth,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    };
    if (comment.moderationState === 'DELETED') {
      return {
        ...base,
        author: null,
        content: null,
        editedAt: null,
        isDeleted: true,
      };
    }
    const author = await this.identities.findUserById(comment.authorUserId);
    if (!isActiveUser(author)) {
      return {
        ...base,
        author: null,
        content: null,
        editedAt: null,
        isDeleted: true,
      };
    }
    return {
      ...base,
      author: { id: author.id, displayName: author.displayName },
      content: comment.content,
      editedAt: comment.editedAt,
      isDeleted: false,
    };
  }

  private async toPostResponseOrThrow(
    post: CommunityPostRecord,
    viewerUserId: string | null,
  ): Promise<CommunityPostResponse> {
    const response = await this.toPostResponse(post, viewerUserId);
    if (!response) {
      return communityFailure('COMMUNITY_POST_UNAVAILABLE', 'Post is not available', 404);
    }
    return response;
  }

  private async toPostResponse(
    post: CommunityPostRecord,
    viewerUserId: string | null,
  ): Promise<CommunityPostResponse | null> {
    const [language] = await this.profiles.findByCodes([post.targetLanguageCode]);
    const author = await this.identities.findUserById(post.authorUserId);
    if (!language?.active || !isActiveUser(author)) return null;
    if (
      post.moderationState !== 'ACTIVE' ||
      (post.visibility === 'PRIVATE' && post.authorUserId !== viewerUserId)
    ) {
      return null;
    }
    const summary = await this.repository.getPostInteractionSummary(post.id, viewerUserId);
    const isShareable = post.visibility === 'PUBLIC';
    return {
      id: post.id,
      author: { id: author.id, displayName: author.displayName },
      targetLanguage: toLanguageResponse(language),
      postType: post.postType,
      content: post.content,
      cefrLevel: post.cefrLevel,
      topic: post.topic,
      visibility: post.visibility,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      editedAt: post.editedAt,
      canonicalPath: isShareable ? '/community/posts/' + post.id : null,
      isShareable,
      isOwner: post.authorUserId === viewerUserId,
      helpfulCount: summary.helpfulCount,
      viewerReacted: summary.viewerReacted,
      commentCount: summary.commentCount,
      isSaved: summary.viewerSaved,
    };
  }

  private async requireActiveLanguage(input: unknown): Promise<string> {
    if (typeof input !== 'string') {
      return communityFailure('COMMUNITY_LANGUAGE_INVALID', 'Language code is invalid');
    }
    const code = input.normalize('NFKC').trim().toLowerCase();
    if (!/^[a-z]{2,35}(?:-[a-z0-9]{2,8})*$/.test(code)) {
      return communityFailure('COMMUNITY_LANGUAGE_INVALID', 'Language code is invalid');
    }
    const [language] = await this.profiles.findByCodes([code]);
    if (!language) {
      return communityFailure('COMMUNITY_LANGUAGE_UNKNOWN', 'Language is not available');
    }
    if (!language.active) {
      return communityFailure('COMMUNITY_LANGUAGE_INACTIVE', 'Language is not active');
    }
    return code;
  }

  private async requireActiveUser(userId: string): Promise<UserRecord> {
    const user = await this.identities.findUserById(userId);
    if (!isActiveUser(user)) {
      return communityFailure('COMMUNITY_AUTHOR_UNAVAILABLE', 'Account is not available', 403);
    }
    return user;
  }

  private decodeCursor(input: unknown): CommunityPostCursor | undefined {
    try {
      return decodeCommunityCursor(input);
    } catch (error) {
      if (error instanceof CommunityValidationError) {
        return communityFailure(error.code, 'Pagination cursor is invalid');
      }
      throw error;
    }
  }

  private normalize<T>(callback: () => T): T {
    try {
      return callback();
    } catch (error) {
      if (error instanceof CommunityValidationError) {
        return communityFailure(error.code, communityMessage(error.code));
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
      communityFailure('COMMUNITY_RATE_LIMITED', 'Please try again later', 429);
    }
  }
}

function normalizeLimit(value: number | undefined): number {
  return normalizeBoundedLimit(value, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
}

function normalizeBoundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    return communityFailure('COMMUNITY_INVALID_LIMIT', 'Page size is invalid');
  }
  return limit;
}

function isActiveUser(user: UserRecord | null): user is UserRecord {
  return Boolean(user && user.status === 'ACTIVE' && user.emailVerifiedAt);
}

function toLanguageResponse(language: LanguageCatalogRecord): CommunityLanguageResponse {
  return {
    code: language.code,
    slug: language.slug,
    nativeName: language.nativeName,
    englishName: language.englishName,
    vietnameseName: language.vietnameseName,
    direction: language.direction,
  };
}

function communityMessage(code: string): string {
  const messages: Record<string, string> = {
    COMMUNITY_CONTENT_INVALID: 'Post content is invalid',
    COMMUNITY_CONTENT_EMPTY: 'Post content cannot be empty',
    COMMUNITY_CONTENT_TOO_LONG: 'Post content is too long',
    COMMUNITY_TOPIC_INVALID: 'Topic is invalid',
    COMMUNITY_POST_TYPE_INVALID: 'Post type is invalid',
    COMMUNITY_CEFR_INVALID: 'CEFR level is invalid',
    COMMUNITY_VISIBILITY_INVALID: 'Visibility is invalid',
    COMMUNITY_REACTION_INVALID: 'Reaction type is invalid',
    COMMUNITY_REPORT_CATEGORY_INVALID: 'Report category is invalid',
    COMMUNITY_REPORT_TARGET_INVALID: 'Report target is invalid',
    COMMUNITY_COMMENT_UNAVAILABLE: 'Comment is not available',
    COMMUNITY_COMMENT_DEPTH_EXCEEDED: 'Replies can only be one level deep',
    COMMUNITY_INVALID_LIMIT: 'Page size is invalid',
    COMMUNITY_VALUE_INVALID: 'Community value is invalid',
  };
  return messages[code] ?? 'Community input is invalid';
}
