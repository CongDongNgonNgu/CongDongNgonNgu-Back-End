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
  CreateStructuredResponseAcceptanceRepositoryInput,
  CorrectionsRepository,
  CreateCorrectionRequestRepositoryInput,
  CreateQuestionRepositoryInput,
  CreateLibraryCandidateRepositoryInput,
  CreateStructuredResponseRepositoryInput,
  Phase06ContributionEventQuery,
} from './corrections.repository';
import { CorrectionsRepositoryConflictError } from './corrections.repository';
import type {
  CorrectionIntent,
  CorrectionRequestRecord,
  LibraryCandidateRecord,
  Phase06ContributionEvent,
  StructuredResponseAcceptanceRecord,
  StructuredResponseInteractionRecord,
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
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
      const response = mapResponse(result.rows[0]);
      await appendContributionEvent(client, {
        eventType: 'STRUCTURED_RESPONSE_CREATED',
        idempotencyKey: `response:${response.id}:created`,
        aggregateId: response.id,
        parentPostId: response.parentPostId,
        responseId: response.id,
        candidateId: null,
        acceptanceId: null,
        actorUserId: response.authorUserId,
        contributorUserId: response.authorUserId,
        responseKind: response.responseKind,
        moderationState: response.moderationState,
        occurredAt: response.createdAt,
      });
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof CorrectionsRepositoryConflictError) throw error;
      if (isConflict(error)) {
        throw new CorrectionsRepositoryConflictError('Structured response conflicts with existing data');
      }
      throw error;
    } finally {
      client.release();
    }
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

  async getStructuredResponseInteraction(
    responseId: string,
    viewerUserId: string | null,
  ): Promise<StructuredResponseInteractionRecord> {
    const [count, viewer, acceptance, candidate] = await Promise.all([
      this.pool.query(
        `SELECT COUNT(*)::int AS count
         FROM community_structured_response_votes
         WHERE response_id = $1
           AND vote_type = 'HELPFUL'::phase06_structured_response_vote_type`,
        [responseId],
      ),
      viewerUserId
        ? this.pool.query(
          `SELECT EXISTS(
             SELECT 1
             FROM community_structured_response_votes
             WHERE response_id = $1
               AND user_id = $2
               AND vote_type = 'HELPFUL'::phase06_structured_response_vote_type
           ) AS exists`,
          [responseId, viewerUserId],
        )
        : Promise.resolve({ rows: [{ exists: false }] }),
      this.pool.query(
        `SELECT acceptance.response_id, acceptance.accepted_at
                , acceptance.id, acceptance.accepted_by_user_id
         FROM community_structured_response_acceptances AS acceptance
         INNER JOIN community_structured_responses AS response
           ON response.parent_post_id = acceptance.parent_post_id
         WHERE response.id = $1
           AND acceptance.revoked_at IS NULL
         ORDER BY acceptance.accepted_at DESC
         LIMIT 1`,
        [responseId],
      ),
      this.pool.query(
        `SELECT state
         FROM community_library_candidates
         WHERE source_response_id = $1
           AND state = 'PENDING_REVIEW'::phase06_library_candidate_state
         ORDER BY created_at DESC
         LIMIT 1`,
        [responseId],
      ),
    ]);
    return {
      helpfulCount: Number(count.rows[0]?.count ?? 0),
      viewerHelpful: Boolean(viewer.rows[0]?.exists),
      acceptedResponseId: acceptance.rows[0]?.response_id
        ? String(acceptance.rows[0].response_id)
        : null,
      acceptedAcceptanceId: acceptance.rows[0]?.id
        ? String(acceptance.rows[0].id)
        : null,
      acceptedByUserId: acceptance.rows[0]?.accepted_by_user_id
        ? String(acceptance.rows[0].accepted_by_user_id)
        : null,
      acceptedAt: acceptance.rows[0]?.accepted_at
        ? new Date(String(acceptance.rows[0].accepted_at))
        : null,
      libraryCandidateState: candidate.rows[0]?.state
        ? String(candidate.rows[0].state) as StructuredResponseInteractionRecord['libraryCandidateState']
        : null,
    };
  }

  async addStructuredResponseHelpfulVote(
    responseId: string,
    userId: string,
    createdAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO community_structured_response_votes (
         response_id, user_id, vote_type, created_at
       )
       VALUES ($1, $2, 'HELPFUL'::phase06_structured_response_vote_type, $3)
       ON CONFLICT (response_id, user_id) DO NOTHING`,
      [responseId, userId, createdAt],
    );
  }

  async removeStructuredResponseHelpfulVote(
    responseId: string,
    userId: string,
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM community_structured_response_votes
       WHERE response_id = $1 AND user_id = $2`,
      [responseId, userId],
    );
  }

  async setStructuredResponseAcceptance(
    input: CreateStructuredResponseAcceptanceRepositoryInput,
  ): Promise<StructuredResponseAcceptanceRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const parent = await client.query(
        'SELECT id FROM community_posts WHERE id = $1 FOR UPDATE',
        [input.parentPostId],
      );
      if (!parent.rows[0]) {
        throw new CorrectionsRepositoryConflictError('Acceptance parent is unavailable');
      }
      const response = await client.query(
        `SELECT author_user_id, response_kind
         FROM community_structured_responses
         WHERE id = $1 AND parent_post_id = $2
         FOR UPDATE`,
        [input.responseId, input.parentPostId],
      );
      if (!response.rows[0]) {
        throw new CorrectionsRepositoryConflictError('Acceptance response is unavailable');
      }
      const current = await client.query(
        `SELECT current_acceptance.*,
                current_response.author_user_id AS current_author_user_id,
                current_response.response_kind AS current_response_kind
         FROM community_structured_response_acceptances AS current_acceptance
         INNER JOIN community_structured_responses AS current_response
           ON current_response.id = current_acceptance.response_id
         WHERE current_acceptance.parent_post_id = $1
           AND current_acceptance.revoked_at IS NULL
         FOR UPDATE`,
        [input.parentPostId],
      );
      if (current.rows[0] && String(current.rows[0].response_id) === input.responseId) {
        await client.query('COMMIT');
        return mapAcceptance(current.rows[0]);
      }
      if (current.rows[0]) {
        await client.query(
          `UPDATE community_structured_response_acceptances
           SET revoked_at = $2
           WHERE id = $1`,
          [current.rows[0].id, input.acceptedAt],
        );
        await invalidateLibraryCandidates(
          client,
          String(current.rows[0].response_id),
          String(current.rows[0].id),
          input.acceptedAt,
          'ACCEPTANCE_REVOKED',
        );
        await appendContributionEvent(client, {
          eventType: 'ACCEPTANCE_REVOKED',
          idempotencyKey: `acceptance:${current.rows[0].id}:revoked`,
          aggregateId: String(current.rows[0].id),
          parentPostId: input.parentPostId,
          responseId: String(current.rows[0].response_id),
          candidateId: null,
          acceptanceId: String(current.rows[0].id),
          actorUserId: input.acceptedByUserId,
          contributorUserId: String(current.rows[0].current_author_user_id),
          responseKind: String(current.rows[0].current_response_kind) as StructuredResponseRecord['responseKind'],
          moderationState: null,
          occurredAt: input.acceptedAt,
        });
      }
      const inserted = await client.query(
        `INSERT INTO community_structured_response_acceptances (
           parent_post_id, response_id, accepted_by_user_id, accepted_at
         )
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [input.parentPostId, input.responseId, input.acceptedByUserId, input.acceptedAt],
      );
      const acceptance = mapAcceptance(inserted.rows[0]);
      await appendContributionEvent(client, {
        eventType: 'RESPONSE_ACCEPTED',
        idempotencyKey: `acceptance:${acceptance.id}:accepted`,
        aggregateId: acceptance.id,
        parentPostId: acceptance.parentPostId,
        responseId: acceptance.responseId,
        candidateId: null,
        acceptanceId: acceptance.id,
        actorUserId: acceptance.acceptedByUserId,
        contributorUserId: String(response.rows[0].author_user_id),
        responseKind: String(response.rows[0].response_kind) as StructuredResponseRecord['responseKind'],
        moderationState: null,
        occurredAt: acceptance.acceptedAt,
      });
      await client.query('COMMIT');
      return acceptance;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof CorrectionsRepositoryConflictError) throw error;
      if (isConflict(error)) {
        throw new CorrectionsRepositoryConflictError('Acceptance conflicts with another active acceptance');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeStructuredResponseAcceptance(
    parentPostId: string,
    _acceptedByUserId: string,
    revokedAt: Date,
  ): Promise<StructuredResponseAcceptanceRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT id FROM community_posts WHERE id = $1 FOR UPDATE',
        [parentPostId],
      );
      const result = await client.query(
        `UPDATE community_structured_response_acceptances
         SET revoked_at = $2
         WHERE parent_post_id = $1 AND revoked_at IS NULL
         RETURNING *`,
        [parentPostId, revokedAt],
      );
      const revoked = result.rows[0] ? mapAcceptance(result.rows[0]) : null;
      if (revoked) {
        const response = await client.query(
          `SELECT author_user_id, response_kind
           FROM community_structured_responses
           WHERE id = $1`,
          [revoked.responseId],
        );
        await invalidateLibraryCandidates(
          client,
          revoked.responseId,
          revoked.id,
          revokedAt,
          'ACCEPTANCE_REVOKED',
        );
        await appendContributionEvent(client, {
          eventType: 'ACCEPTANCE_REVOKED',
          idempotencyKey: `acceptance:${revoked.id}:revoked`,
          aggregateId: revoked.id,
          parentPostId: revoked.parentPostId,
          responseId: revoked.responseId,
          candidateId: null,
          acceptanceId: revoked.id,
          actorUserId: _acceptedByUserId,
          contributorUserId: response.rows[0]?.author_user_id
            ? String(response.rows[0].author_user_id)
            : null,
          responseKind: response.rows[0]?.response_kind
            ? String(response.rows[0].response_kind) as StructuredResponseRecord['responseKind']
            : null,
          moderationState: null,
          occurredAt: revokedAt,
        });
      }
      await client.query('COMMIT');
      return revoked;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async setStructuredResponseModerationState(
    id: string,
    moderationState: CommunityModerationState,
    now: Date,
    actorUserId: string | null = null,
  ): Promise<StructuredResponseRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
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
      if (!result.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const response = mapResponse(result.rows[0]);
      if (moderationState !== 'ACTIVE') {
        await invalidateLibraryCandidates(client, response.id, null, now, 'RESPONSE_MODERATED');
      }
      await appendContributionEvent(client, {
        eventType: 'STRUCTURED_RESPONSE_MODERATED',
        idempotencyKey: `response:${response.id}:moderated:${moderationState}:${now.toISOString()}`,
        aggregateId: response.id,
        parentPostId: response.parentPostId,
        responseId: response.id,
        candidateId: null,
        acceptanceId: null,
        actorUserId,
        contributorUserId: response.authorUserId,
        responseKind: response.responseKind,
        moderationState,
        occurredAt: now,
      });
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createLibraryCandidate(
    input: CreateLibraryCandidateRepositoryInput,
  ): Promise<LibraryCandidateRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const source = await client.query(
        `SELECT
           response.id AS response_id,
           response.parent_post_id,
           response.author_user_id,
           response.response_kind,
           response.corrected_text,
           response.answer_text,
           response.explanation,
           response.moderation_state AS response_moderation_state,
           post.visibility AS parent_visibility,
           post.moderation_state AS parent_moderation_state,
           post.post_type AS parent_post_type,
           post.content AS parent_content,
           post.target_language_id,
           languages.code AS target_language_code,
           correction.original_text
         FROM community_structured_responses AS response
         INNER JOIN community_posts AS post ON post.id = response.parent_post_id
         INNER JOIN languages ON languages.id = post.target_language_id
         LEFT JOIN community_correction_requests AS correction ON correction.post_id = post.id
         WHERE response.id = $1
         FOR UPDATE OF response, post`,
        [input.responseId],
      );
      const sourceRow = source.rows[0];
      if (
        !sourceRow ||
        String(sourceRow.response_moderation_state) !== 'ACTIVE' ||
        String(sourceRow.parent_moderation_state) !== 'ACTIVE' ||
        String(sourceRow.parent_visibility) !== 'PUBLIC' ||
        !matchesResponseKind(String(sourceRow.response_kind), String(sourceRow.parent_post_type))
      ) {
        throw new CorrectionsRepositoryConflictError('Library candidate source is unavailable');
      }
      const acceptanceResult = await client.query(
        `SELECT *
         FROM community_structured_response_acceptances
         WHERE parent_post_id = $1
           AND response_id = $2
           AND revoked_at IS NULL
         FOR UPDATE`,
        [sourceRow.parent_post_id, input.responseId],
      );
      const acceptanceRow = acceptanceResult.rows[0];
      if (!acceptanceRow) {
        throw new CorrectionsRepositoryConflictError('Library candidate response is not accepted');
      }
      const existing = await client.query(
        `SELECT candidate.*, languages.code AS target_language_code
         FROM community_library_candidates AS candidate
         INNER JOIN languages ON languages.id = candidate.target_language_id
         WHERE candidate.source_response_id = $1
           AND candidate.state = 'PENDING_REVIEW'::phase06_library_candidate_state
         ORDER BY candidate.created_at DESC
         LIMIT 1
         FOR UPDATE OF candidate`,
        [input.responseId],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return mapCandidate(existing.rows[0]);
      }
      const inserted = await client.query(
        `INSERT INTO community_library_candidates (
           source_post_id,
           source_response_id,
           contributor_user_id,
           target_language_id,
           response_kind,
           source_text,
           corrected_text,
           answer_text,
           explanation,
           acceptance_id,
           accepted_by_user_id,
           accepted_at,
           candidate_created_by_user_id,
           created_at,
           updated_at
         )
         VALUES (
           $1, $2, $3, $4, $5::phase06_structured_response_kind,
           $6, $7, $8, $9, $10, $11, $12, $13, $14, $14
         )
         RETURNING *`,
        [
          sourceRow.parent_post_id,
          input.responseId,
          sourceRow.author_user_id,
          sourceRow.target_language_id,
          sourceRow.response_kind,
          sourceRow.original_text ?? sourceRow.parent_content,
          sourceRow.corrected_text ?? null,
          sourceRow.answer_text ?? null,
          sourceRow.explanation ?? null,
          acceptanceRow.id,
          acceptanceRow.accepted_by_user_id,
          acceptanceRow.accepted_at,
          input.candidateCreatedByUserId,
          input.createdAt,
        ],
      );
      const candidate = mapCandidate({
        ...inserted.rows[0],
        target_language_code: sourceRow.target_language_code,
      });
      await appendContributionEvent(client, {
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
      await client.query('COMMIT');
      return candidate;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof CorrectionsRepositoryConflictError) throw error;
      if (isConflict(error)) {
        throw new CorrectionsRepositoryConflictError('Library candidate conflicts with existing data');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listPendingLibraryCandidates(limit = 100): Promise<LibraryCandidateRecord[]> {
    const result = await this.pool.query(
      `SELECT candidate.*, languages.code AS target_language_code
       FROM community_library_candidates AS candidate
       INNER JOIN community_posts AS post
         ON post.id = candidate.source_post_id
       INNER JOIN community_structured_responses AS response
         ON response.id = candidate.source_response_id
        AND response.parent_post_id = candidate.source_post_id
       INNER JOIN languages ON languages.id = candidate.target_language_id
       INNER JOIN community_structured_response_acceptances AS acceptance
         ON acceptance.id = candidate.acceptance_id
        AND acceptance.response_id = candidate.source_response_id
        AND acceptance.revoked_at IS NULL
       WHERE candidate.state = 'PENDING_REVIEW'::phase06_library_candidate_state
         AND post.visibility = 'PUBLIC'::community_post_visibility
         AND post.moderation_state = 'ACTIVE'::community_moderation_state
         AND response.moderation_state = 'ACTIVE'::community_moderation_state
       ORDER BY candidate.created_at ASC, candidate.id ASC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)],
    );
    return result.rows.map(mapCandidate);
  }

  async listContributionEvents(
    query: Phase06ContributionEventQuery = {},
  ): Promise<Phase06ContributionEvent[]> {
    const values: unknown[] = [];
    const where: string[] = [];
    if (query.parentPostId) {
      values.push(query.parentPostId);
      where.push(`parent_post_id = $${values.length}`);
    }
    if (query.responseId) {
      values.push(query.responseId);
      where.push(`response_id = $${values.length}`);
    }
    if (query.candidateId) {
      values.push(query.candidateId);
      where.push(`candidate_id = $${values.length}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM phase06_contribution_events` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY occurred_at ASC, id ASC',
      values,
    );
    return result.rows.map(mapContributionEvent);
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

function mapAcceptance(row: Record<string, unknown>): StructuredResponseAcceptanceRecord {
  return {
    id: String(row.id),
    parentPostId: String(row.parent_post_id),
    responseId: String(row.response_id),
    acceptedByUserId: String(row.accepted_by_user_id),
    acceptedAt: new Date(String(row.accepted_at)),
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
  };
}

async function appendContributionEvent(
  executor: Pool | PoolClient,
  event: Omit<Phase06ContributionEvent, 'id'>,
): Promise<void> {
  await executor.query(
    `INSERT INTO phase06_contribution_events (
       event_type,
       idempotency_key,
       aggregate_id,
       parent_post_id,
       response_id,
       candidate_id,
       acceptance_id,
       actor_user_id,
       contributor_user_id,
       response_kind,
       moderation_state,
       occurred_at
     )
     VALUES (
       $1::phase06_contribution_event_type,
       $2,
       $3,
       $4,
       $5,
       $6,
       $7,
       $8,
       $9,
       $10::phase06_structured_response_kind,
       $11::community_moderation_state,
       $12
     )
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      event.eventType,
      event.idempotencyKey,
      event.aggregateId,
      event.parentPostId,
      event.responseId,
      event.candidateId,
      event.acceptanceId,
      event.actorUserId,
      event.contributorUserId,
      event.responseKind,
      event.moderationState,
      event.occurredAt,
    ],
  );
}

async function invalidateLibraryCandidates(
  executor: Pool | PoolClient,
  responseId: string,
  acceptanceId: string | null,
  now: Date,
  reason: string,
): Promise<void> {
  await executor.query(
    `UPDATE community_library_candidates
     SET state = 'INVALIDATED'::phase06_library_candidate_state,
         invalidated_at = $2,
         invalidation_reason = $3,
         updated_at = $2
     WHERE source_response_id = $1
       AND state = 'PENDING_REVIEW'::phase06_library_candidate_state
       AND ($4::uuid IS NULL OR acceptance_id = $4)`,
    [responseId, now, reason, acceptanceId],
  );
}

function mapCandidate(row: Record<string, unknown>): LibraryCandidateRecord {
  return {
    id: String(row.id),
    sourcePostId: String(row.source_post_id),
    sourceResponseId: String(row.source_response_id),
    contributorUserId: String(row.contributor_user_id),
    targetLanguageCode: String(row.target_language_code),
    responseKind: String(row.response_kind) as LibraryCandidateRecord['responseKind'],
    sourceText: String(row.source_text),
    correctedText: row.corrected_text === null || row.corrected_text === undefined
      ? null
      : String(row.corrected_text),
    answerText: row.answer_text === null || row.answer_text === undefined
      ? null
      : String(row.answer_text),
    explanation: row.explanation === null || row.explanation === undefined
      ? null
      : String(row.explanation),
    acceptanceId: String(row.acceptance_id),
    acceptedByUserId: String(row.accepted_by_user_id),
    acceptedAt: new Date(String(row.accepted_at)),
    candidateCreatedByUserId: String(row.candidate_created_by_user_id),
    state: String(row.state) as LibraryCandidateRecord['state'],
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    invalidatedAt: row.invalidated_at ? new Date(String(row.invalidated_at)) : null,
    invalidationReason: row.invalidation_reason ? String(row.invalidation_reason) : null,
  };
}

function mapContributionEvent(row: Record<string, unknown>): Phase06ContributionEvent {
  return {
    id: String(row.id),
    eventType: String(row.event_type) as Phase06ContributionEvent['eventType'],
    idempotencyKey: String(row.idempotency_key),
    aggregateId: String(row.aggregate_id),
    parentPostId: String(row.parent_post_id),
    responseId: row.response_id ? String(row.response_id) : null,
    candidateId: row.candidate_id ? String(row.candidate_id) : null,
    acceptanceId: row.acceptance_id ? String(row.acceptance_id) : null,
    actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
    contributorUserId: row.contributor_user_id ? String(row.contributor_user_id) : null,
    responseKind: row.response_kind
      ? String(row.response_kind) as Phase06ContributionEvent['responseKind']
      : null,
    moderationState: row.moderation_state
      ? String(row.moderation_state) as Phase06ContributionEvent['moderationState']
      : null,
    occurredAt: new Date(String(row.occurred_at)),
  };
}

function matchesResponseKind(responseKind: string, parentPostType: string): boolean {
  return (
    (responseKind === 'CORRECTION_PROPOSAL' && parentPostType === 'CORRECTION_REQUEST') ||
    (responseKind === 'QA_ANSWER' && parentPostType === 'QUESTION')
  );
}
