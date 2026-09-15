import type { Pool, PoolClient } from 'pg';
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
  CorrectionsRepository,
  CreateCorrectionRequestRepositoryInput,
  CreateQuestionRepositoryInput,
  CreateStructuredResponseRepositoryInput,
} from './corrections.repository';
import { CorrectionsRepositoryConflictError } from './corrections.repository';
import type {
  CorrectionIntent,
  CorrectionRequestRecord,
  StructuredResponseListQuery,
  StructuredResponseRecord,
} from './corrections.types';

export class PostgresCorrectionsRepository implements CorrectionsRepository {
  constructor(private readonly pool: Pool) {}

  async createCorrectionRequest(
    input: CreateCorrectionRequestRepositoryInput,
  ): Promise<{ post: CommunityPostRecord; correction: CorrectionRequestRecord }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const post = await this.insertParentPost(client, {
        authorUserId: input.authorUserId,
        targetLanguageCode: input.targetLanguageCode,
        postType: 'CORRECTION_REQUEST',
        content: input.parentContent,
        cefrLevel: input.cefrLevel,
        topic: input.topic,
        visibility: input.visibility,
        createdAt: input.createdAt,
      });
      const result = await client.query(
        `INSERT INTO community_correction_requests (
           post_id, original_text, correction_intent, context, created_at, updated_at
         )
         VALUES ($1, $2, $3::phase06_correction_intent, $4, $5, $5)
         RETURNING *`,
        [
          post.id,
          input.originalText,
          input.correctionIntent,
          input.context,
          input.createdAt,
        ],
      );
      await client.query('COMMIT');
      return {
        post,
        correction: mapCorrection(result.rows[0]),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      if (isConflict(error)) {
        throw new CorrectionsRepositoryConflictError();
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async createQuestion(input: CreateQuestionRepositoryInput): Promise<CommunityPostRecord> {
    return this.insertParentPost(this.pool, {
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
    const result = await this.pool.query(
      'SELECT * FROM community_correction_requests WHERE post_id = $1',
      [postId],
    );
    return result.rows[0] ? mapCorrection(result.rows[0]) : null;
  }

  async createStructuredResponse(
    input: CreateStructuredResponseRepositoryInput,
  ): Promise<StructuredResponseRecord> {
    const result = await this.pool.query(
      `WITH inserted AS (
         INSERT INTO community_structured_responses (
           parent_post_id,
           author_user_id,
           response_kind,
           corrected_text,
           answer_text,
           explanation,
           created_at,
           updated_at
         )
         SELECT
           $1,
           $2,
           $3::phase06_structured_response_kind,
           $4,
           $5,
           $6,
           $7,
           $7
         FROM community_posts
         WHERE id = $1
           AND post_type = $8::community_post_type
           AND moderation_state = 'ACTIVE'::community_moderation_state
         RETURNING *
       )
       SELECT * FROM inserted`,
      [
        input.parentPostId,
        input.authorUserId,
        input.responseKind,
        input.correctedText,
        input.answerText,
        input.explanation,
        input.createdAt,
        input.parentPostType,
      ],
    );
    if (!result.rows[0]) {
      throw new CorrectionsRepositoryConflictError('Structured response parent is invalid');
    }
    return mapResponse(result.rows[0]);
  }

  async findStructuredResponseById(id: string): Promise<StructuredResponseRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM community_structured_responses WHERE id = $1',
      [id],
    );
    return result.rows[0] ? mapResponse(result.rows[0]) : null;
  }

  async listStructuredResponses(
    query: StructuredResponseListQuery,
  ): Promise<CommunityListResult<StructuredResponseRecord>> {
    const values: unknown[] = [query.parentPostId, 'HIDDEN'];
    const where = [
      'parent_post_id = $1',
      'moderation_state <> $2::community_moderation_state',
    ];
    appendCursorCondition(where, values, query.before);
    values.push(query.limit + 1);
    const result = await this.pool.query(
      'SELECT *' +
      ' FROM community_structured_responses' +
      ' WHERE ' + where.join(' AND ') +
      ' ORDER BY created_at DESC, id DESC' +
      ' LIMIT $' + values.length,
      values,
    );
    return page(result.rows.map(mapResponse), query.limit);
  }

  async setStructuredResponseModerationState(
    id: string,
    moderationState: CommunityModerationState,
    now: Date,
  ): Promise<StructuredResponseRecord | null> {
    const result = await this.pool.query(
      `UPDATE community_structured_responses
       SET moderation_state = $2::community_moderation_state,
           deleted_at = CASE
             WHEN $2::community_moderation_state = 'DELETED'::community_moderation_state
             THEN COALESCE(deleted_at, $3)
             ELSE deleted_at
           END,
           updated_at = $3
       WHERE id = $1
       RETURNING *`,
      [id, moderationState, now],
    );
    return result.rows[0] ? mapResponse(result.rows[0]) : null;
  }

  private async insertParentPost(
    executor: Pool | PoolClient,
    input: {
      authorUserId: string;
      targetLanguageCode: string;
      postType: Extract<CommunityPostType, 'QUESTION' | 'CORRECTION_REQUEST'>;
      content: string;
      cefrLevel: CommunityCefrLevel | null;
      topic: string | null;
      visibility: CommunityVisibility;
      createdAt: Date;
    },
  ): Promise<CommunityPostRecord> {
    const result = await executor.query(
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
    if (!result.rows[0]) {
      throw new CorrectionsRepositoryConflictError('Language is unavailable');
    }
    return mapPost(result.rows[0]);
  }
}

function appendCursorCondition(
  where: string[],
  values: unknown[],
  cursor: CommunityPostCursor | undefined,
): void {
  if (!cursor) return;
  values.push(cursor.createdAt);
  const createdAtParameter = '$' + values.length;
  values.push(cursor.id);
  const idParameter = '$' + values.length;
  where.push(
    '(created_at < ' + createdAtParameter +
    ' OR (created_at = ' + createdAtParameter +
    ' AND id < ' + idParameter + '))',
  );
}

function page<T>(items: T[], limit: number): CommunityListResult<T> {
  return {
    items: items.slice(0, limit),
    hasMore: items.length > limit,
  };
}

function isConflict(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505',
  );
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

function mapCorrection(row: Record<string, unknown>): CorrectionRequestRecord {
  return {
    postId: String(row.post_id),
    originalText: String(row.original_text),
    correctionIntent: String(row.correction_intent) as CorrectionIntent,
    context: row.context === null || row.context === undefined ? null : String(row.context),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function mapResponse(row: Record<string, unknown>): StructuredResponseRecord {
  return {
    id: String(row.id),
    parentPostId: String(row.parent_post_id),
    authorUserId: String(row.author_user_id),
    responseKind: String(row.response_kind) as StructuredResponseRecord['responseKind'],
    correctedText: row.corrected_text === null || row.corrected_text === undefined
      ? null
      : String(row.corrected_text),
    answerText: row.answer_text === null || row.answer_text === undefined
      ? null
      : String(row.answer_text),
    explanation: row.explanation === null || row.explanation === undefined
      ? null
      : String(row.explanation),
    moderationState: String(row.moderation_state) as CommunityModerationState,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    editedAt: row.edited_at ? new Date(String(row.edited_at)) : null,
    deletedAt: row.deleted_at ? new Date(String(row.deleted_at)) : null,
    deletedByUserId: row.deleted_by_user_id ? String(row.deleted_by_user_id) : null,
  };
}
