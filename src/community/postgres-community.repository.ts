import type { Pool } from 'pg';
import type {
  CommunityCefrLevel,
  CommunityCommentRecord,
  CommunityCommentThreadRecord,
  CommunityInteractionSummary,
  CommunityListResult,
  CommunityModerationState,
  CommunityPostRecord,
  CommunityPostType,
  CommunityReactionType,
  CommunityReportInput,
  CommunityVisibility,
} from './community.types';
import type {
  CommunityCommentListQuery,
  CommunityPostListQuery,
  CommunityRepository,
  CreateCommunityCommentInput,
  CreateCommunityPostInput,
  UpdateCommunityCommentInput,
  UpdateCommunityPostInput,
} from './community.repository';
import { CommunityRepositoryConflictError } from './community.repository';

export class PostgresCommunityRepository implements CommunityRepository {
  constructor(private readonly pool: Pool) {}

  async createPost(input: CreateCommunityPostInput): Promise<CommunityPostRecord> {
    const result = await this.pool.query(
      `WITH inserted AS (
         INSERT INTO community_posts (
           author_user_id,
           target_language_id,
           post_type,
           content,
           cefr_level,
           topic,
           visibility,
           created_at,
           updated_at
         )
         SELECT
           $1,
           id,
           $2::community_post_type,
           $3,
           $4::community_cefr_level,
           $5,
           $6::community_post_visibility,
           $7,
           $7
         FROM languages
         WHERE code = $8 AND active = true
         RETURNING *
       )
       SELECT inserted.*, languages.code AS target_language_code
       FROM inserted
       INNER JOIN languages ON languages.id = inserted.target_language_id`,
      [
        input.authorUserId,
        input.postType,
        input.content,
        input.cefrLevel,
        input.topic,
        input.visibility,
        input.createdAt,
        input.targetLanguageCode,
      ],
    );
    if (!result.rows[0]) throw new CommunityRepositoryConflictError('Language is unavailable');
    return mapPost(result.rows[0]);
  }

  async findPostById(id: string): Promise<CommunityPostRecord | null> {
    const result = await this.pool.query(
      `SELECT p.*, l.code AS target_language_code
       FROM community_posts p
       INNER JOIN languages l ON l.id = p.target_language_id
       WHERE p.id = $1`,
      [id],
    );
    return result.rows[0] ? mapPost(result.rows[0]) : null;
  }

  async updatePost(id: string, input: UpdateCommunityPostInput): Promise<CommunityPostRecord | null> {
    const values: unknown[] = [id];
    const updates: string[] = [];
    if (input.targetLanguageCode !== undefined) {
      values.push(input.targetLanguageCode);
      updates.push('target_language_id = (SELECT id FROM languages WHERE code = $' + values.length + ' AND active = true)');
    }
    if (input.postType !== undefined) {
      values.push(input.postType);
      updates.push('post_type = $' + values.length + '::community_post_type');
    }
    if (input.content !== undefined) {
      values.push(input.content);
      updates.push('content = $' + values.length);
    }
    if (input.cefrLevel !== undefined) {
      values.push(input.cefrLevel);
      updates.push('cefr_level = $' + values.length + '::community_cefr_level');
    }
    if (input.topic !== undefined) {
      values.push(input.topic);
      updates.push('topic = $' + values.length);
    }
    if (input.visibility !== undefined) {
      values.push(input.visibility);
      updates.push('visibility = $' + values.length + '::community_post_visibility');
    }
    values.push(input.updatedAt);
    updates.push('updated_at = $' + values.length);
    values.push(input.editedAt);
    updates.push('edited_at = $' + values.length);

    const result = await this.pool.query(
      `WITH updated AS (
         UPDATE community_posts
         SET ${updates.join(', ')}
         WHERE id = $1 AND moderation_state = 'ACTIVE'::community_moderation_state
         RETURNING *
       )
       SELECT updated.*, languages.code AS target_language_code
       FROM updated
       INNER JOIN languages ON languages.id = updated.target_language_id`,
      values,
    );
    return result.rows[0] ? mapPost(result.rows[0]) : null;
  }

  async softDeletePost(
    id: string,
    deletedByUserId: string,
    now: Date,
  ): Promise<CommunityPostRecord | null> {
    const result = await this.pool.query(
      `WITH deleted AS (
         UPDATE community_posts
         SET moderation_state = 'DELETED'::community_moderation_state,
             deleted_at = $2,
             deleted_by_user_id = $3,
             updated_at = $2
         WHERE id = $1 AND moderation_state <> 'DELETED'::community_moderation_state
         RETURNING *
       )
       SELECT deleted.*, languages.code AS target_language_code
       FROM deleted
       INNER JOIN languages ON languages.id = deleted.target_language_id`,
      [id, now, deletedByUserId],
    );
    if (result.rows[0]) return mapPost(result.rows[0]);
    return this.findPostById(id);
  }

  async setPostModerationState(
    id: string,
    moderationState: CommunityModerationState,
    now: Date,
  ): Promise<CommunityPostRecord | null> {
    const result = await this.pool.query(
      `WITH updated AS (
         UPDATE community_posts
         SET moderation_state = $2::community_moderation_state,
             deleted_at = CASE WHEN $2::community_moderation_state = 'DELETED'::community_moderation_state
                               THEN COALESCE(deleted_at, $3)
                               ELSE deleted_at END,
             updated_at = $3
         WHERE id = $1
         RETURNING *
       )
       SELECT updated.*, languages.code AS target_language_code
       FROM updated
       INNER JOIN languages ON languages.id = updated.target_language_id`,
      [id, moderationState, now],
    );
    return result.rows[0] ? mapPost(result.rows[0]) : null;
  }

  async listPosts(query: CommunityPostListQuery): Promise<CommunityListResult<CommunityPostRecord>> {
    const values: unknown[] = [];
    const where = [
      `p.visibility = 'PUBLIC'::community_post_visibility`,
      `p.moderation_state = 'ACTIVE'::community_moderation_state`,
      'l.active = true',
      `u.status = 'ACTIVE'::user_status`,
    ];
    if (query.languageCode) {
      values.push(query.languageCode);
      where.push('l.code = $' + values.length);
    }
    appendCursorCondition(where, values, query.before, 'p');
    values.push(query.limit + 1);

    const result = await this.pool.query(
      `SELECT p.*, l.code AS target_language_code
       FROM community_posts p
       INNER JOIN languages l ON l.id = p.target_language_id
       INNER JOIN users u ON u.id = p.author_user_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $${values.length}`,
      values,
    );
    return page(result.rows.map(mapPost), query.limit);
  }

  async listSavedPosts(
    userId: string,
    query: CommunityPostListQuery,
  ): Promise<CommunityListResult<CommunityPostRecord>> {
    const values: unknown[] = [userId];
    const where = [
      's.user_id = $1',
      `p.moderation_state = 'ACTIVE'::community_moderation_state`,
      `(p.visibility = 'PUBLIC'::community_post_visibility OR p.author_user_id = $1)`,
      'l.active = true',
      `u.status = 'ACTIVE'::user_status`,
    ];
    appendCursorCondition(where, values, query.before, 'p');
    values.push(query.limit + 1);

    const result = await this.pool.query(
      `SELECT p.*, l.code AS target_language_code
       FROM community_saved_posts s
       INNER JOIN community_posts p ON p.id = s.post_id
       INNER JOIN languages l ON l.id = p.target_language_id
       INNER JOIN users u ON u.id = p.author_user_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $${values.length}`,
      values,
    );
    return page(result.rows.map(mapPost), query.limit);
  }

  async getPostInteractionSummary(
    postId: string,
    viewerUserId: string | null,
  ): Promise<CommunityInteractionSummary> {
    const [reactions, comments, viewerReaction, viewerSave] = await Promise.all([
      this.pool.query(
        `SELECT COUNT(*)::int AS count
         FROM community_reactions
         WHERE post_id = $1 AND reaction_type = 'HELPFUL'::community_reaction_type`,
        [postId],
      ),
      this.pool.query(
        `SELECT COUNT(*)::int AS count
         FROM community_comments
         WHERE post_id = $1 AND moderation_state = 'ACTIVE'::community_moderation_state`,
        [postId],
      ),
      viewerUserId
        ? this.pool.query(
            `SELECT EXISTS(
               SELECT 1 FROM community_reactions
               WHERE user_id = $1 AND post_id = $2 AND reaction_type = 'HELPFUL'::community_reaction_type
             ) AS exists`,
            [viewerUserId, postId],
          )
        : Promise.resolve({ rows: [{ exists: false }] }),
      viewerUserId
        ? this.pool.query(
            `SELECT EXISTS(SELECT 1 FROM community_saved_posts WHERE user_id = $1 AND post_id = $2) AS exists`,
            [viewerUserId, postId],
          )
        : Promise.resolve({ rows: [{ exists: false }] }),
    ]);
    return {
      helpfulCount: Number(reactions.rows[0]?.count ?? 0),
      commentCount: Number(comments.rows[0]?.count ?? 0),
      viewerReacted: Boolean(viewerReaction.rows[0]?.exists),
      viewerSaved: Boolean(viewerSave.rows[0]?.exists),
    };
  }

  async createComment(input: CreateCommunityCommentInput): Promise<CommunityCommentRecord> {
    const result = await this.pool.query(
      `INSERT INTO community_comments (
         post_id, author_user_id, parent_comment_id, depth, content, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       RETURNING *`,
      [
        input.postId,
        input.authorUserId,
        input.parentCommentId,
        input.depth,
        input.content,
        input.createdAt,
      ],
    );
    return mapComment(result.rows[0]);
  }

  async findCommentById(id: string): Promise<CommunityCommentRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM community_comments WHERE id = $1',
      [id],
    );
    return result.rows[0] ? mapComment(result.rows[0]) : null;
  }

  async updateComment(
    id: string,
    input: UpdateCommunityCommentInput,
  ): Promise<CommunityCommentRecord | null> {
    const result = await this.pool.query(
      `UPDATE community_comments
       SET content = $2, updated_at = $3, edited_at = $4
       WHERE id = $1 AND moderation_state = 'ACTIVE'::community_moderation_state
       RETURNING *`,
      [id, input.content, input.updatedAt, input.editedAt],
    );
    return result.rows[0] ? mapComment(result.rows[0]) : null;
  }

  async softDeleteComment(
    id: string,
    deletedByUserId: string,
    now: Date,
  ): Promise<CommunityCommentRecord | null> {
    const result = await this.pool.query(
      `UPDATE community_comments
       SET moderation_state = 'DELETED'::community_moderation_state,
           deleted_at = $2,
           deleted_by_user_id = $3,
           updated_at = $2
       WHERE id = $1 AND moderation_state <> 'DELETED'::community_moderation_state
       RETURNING *`,
      [id, now, deletedByUserId],
    );
    if (result.rows[0]) return mapComment(result.rows[0]);
    return this.findCommentById(id);
  }

  async listCommentThreads(
    query: CommunityCommentListQuery,
  ): Promise<CommunityListResult<CommunityCommentThreadRecord>> {
    const values: unknown[] = [query.postId];
    const where = [
      'post_id = $1',
      'parent_comment_id IS NULL',
      `moderation_state <> 'HIDDEN'::community_moderation_state`,
    ];
    appendCursorCondition(where, values, query.before, '');
    values.push(query.limit + 1);
    const commentsResult = await this.pool.query(
      `SELECT *
       FROM community_comments
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`,
      values,
    );
    const pageResult = page(commentsResult.rows.map(mapComment), query.limit);
    if (pageResult.items.length === 0) return { items: [], hasMore: pageResult.hasMore };

    const parentIds = pageResult.items.map((comment) => comment.id);
    const repliesResult = await this.pool.query(
      `WITH ranked AS (
         SELECT c.*,
                row_number() OVER (
                  PARTITION BY parent_comment_id
                  ORDER BY created_at ASC, id ASC
                ) AS reply_rank
         FROM community_comments c
         WHERE parent_comment_id = ANY($1::uuid[])
           AND moderation_state <> 'HIDDEN'::community_moderation_state
       )
       SELECT *
       FROM ranked
       WHERE reply_rank <= $2
       ORDER BY parent_comment_id ASC, created_at ASC, id ASC`,
      [parentIds, query.replyLimit + 1],
    );
    const repliesByParent = new Map<string, CommunityCommentRecord[]>();
    for (const row of repliesResult.rows) {
      const reply = mapComment(row);
      const replies = repliesByParent.get(reply.parentCommentId!) ?? [];
      replies.push(reply);
      repliesByParent.set(reply.parentCommentId!, replies);
    }
    return {
      items: pageResult.items.map((comment) => {
        const replies = repliesByParent.get(comment.id) ?? [];
        return {
          comment,
          replies: replies.slice(0, query.replyLimit),
          hasMoreReplies: replies.length > query.replyLimit,
        };
      }),
      hasMore: pageResult.hasMore,
    };
  }

  async addReaction(
    userId: string,
    postId: string,
    reactionType: CommunityReactionType,
    now: Date,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO community_reactions (user_id, post_id, reaction_type, created_at)
       VALUES ($1, $2, $3::community_reaction_type, $4)
       ON CONFLICT (user_id, post_id, reaction_type) DO NOTHING`,
      [userId, postId, reactionType, now],
    );
  }

  async removeReaction(userId: string, postId: string, reactionType: CommunityReactionType): Promise<void> {
    await this.pool.query(
      `DELETE FROM community_reactions
       WHERE user_id = $1 AND post_id = $2 AND reaction_type = $3::community_reaction_type`,
      [userId, postId, reactionType],
    );
  }

  async savePost(userId: string, postId: string, now: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO community_saved_posts (user_id, post_id, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, post_id) DO NOTHING`,
      [userId, postId, now],
    );
  }

  async unsavePost(userId: string, postId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM community_saved_posts WHERE user_id = $1 AND post_id = $2',
      [userId, postId],
    );
  }

  async createReport(input: CommunityReportInput): Promise<void> {
    const postId = input.targetType === 'POST' ? input.targetId : null;
    const commentId = input.targetType === 'COMMENT' ? input.targetId : null;
    await this.pool.query(
      `INSERT INTO community_reports (
         reporter_user_id, target_post_id, target_comment_id, category, details, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4::community_report_category, $5, $6, $6)
       ON CONFLICT DO NOTHING`,
      [
        input.reporterUserId,
        postId,
        commentId,
        input.category,
        input.details,
        input.createdAt,
      ],
    );
  }
}

function appendCursorCondition(
  where: string[],
  values: unknown[],
  cursor: { createdAt: Date; id: string } | undefined,
  alias: string,
): void {
  if (!cursor) return;
  const prefix = alias ? alias + '.' : '';
  values.push(cursor.createdAt);
  const createdAtParameter = '$' + values.length;
  values.push(cursor.id);
  const idParameter = '$' + values.length;
  where.push(
    '(' + prefix + 'created_at < ' + createdAtParameter +
    ' OR (' + prefix + 'created_at = ' + createdAtParameter +
    ' AND ' + prefix + 'id < ' + idParameter + '))',
  );
}

function page<T>(items: T[], limit: number): CommunityListResult<T> {
  return {
    items: items.slice(0, limit),
    hasMore: items.length > limit,
  };
}

function mapPost(row: Record<string, unknown>): CommunityPostRecord {
  return {
    id: String(row.id),
    authorUserId: String(row.author_user_id),
    targetLanguageCode: String(row.target_language_code),
    postType: String(row.post_type) as CommunityPostType,
    content: String(row.content),
    cefrLevel: row.cefr_level ? String(row.cefr_level) as CommunityCefrLevel : null,
    topic: row.topic ? String(row.topic) : null,
    visibility: String(row.visibility) as CommunityVisibility,
    moderationState: String(row.moderation_state) as CommunityModerationState,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    editedAt: row.edited_at ? new Date(String(row.edited_at)) : null,
    deletedAt: row.deleted_at ? new Date(String(row.deleted_at)) : null,
    deletedByUserId: row.deleted_by_user_id ? String(row.deleted_by_user_id) : null,
  };
}

function mapComment(row: Record<string, unknown>): CommunityCommentRecord {
  return {
    id: String(row.id),
    postId: String(row.post_id),
    authorUserId: String(row.author_user_id),
    parentCommentId: row.parent_comment_id ? String(row.parent_comment_id) : null,
    depth: Number(row.depth) as 0 | 1,
    content: String(row.content),
    moderationState: String(row.moderation_state) as CommunityModerationState,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    editedAt: row.edited_at ? new Date(String(row.edited_at)) : null,
    deletedAt: row.deleted_at ? new Date(String(row.deleted_at)) : null,
    deletedByUserId: row.deleted_by_user_id ? String(row.deleted_by_user_id) : null,
  };
}
