import type { Pool, PoolClient } from 'pg';
import {
  mergeNormalizedProvenanceEntries,
  LibraryValidationError,
} from './library.normalization';
import {
  LibraryRepositoryConflictError,
  type CreateLibraryResourceRepositoryInput,
  type LibraryRepository,
  type LibrarySearchRepositoryInput,
  type LibrarySearchRepositoryPage,
  type LibraryInvalidSourceQueueRepositoryInput,
  type LibraryReviewTransitionResult,
  type LibraryReviewQueueRepositoryInput,
  type LibraryReviewQueueRepositoryPage,
  type LibraryProvenanceMutationExpectation,
  type SubmitLibraryContributionRepositoryInput,
  type TransitionLibraryReviewRepositoryInput,
  type ReconcileLibrarySourceRepositoryInput,
} from './library.repository';
import {
  evaluatePhase06SourceHealth,
  type Phase06SourceHealth,
  type Phase06SourceReference,
  type Phase06SourceHealthRow,
} from '../corrections/corrections.source-health';
import { formatLibrarySourceInvalidationNote } from './library.source-reconciliation';
import type {
  CulturalNoteDetails,
  DialogueDetails,
  GrammarItemDetails,
  IdiomDetails,
  LearningCollectionDetails,
  LibraryContributionEventRecord,
  LibraryContributionSubmissionResult,
  LibraryLicenseRecord,
  LibraryProvenanceRecord,
  LibraryResourceDetails,
  LibraryResourceRecord,
  LibraryReviewAuditRecord,
  NormalizedLibraryLicenseInput,
  NormalizedLibraryProvenanceInput,
  PronunciationDetails,
  SentenceDetails,
  SlangDetails,
  TranslationDetails,
  VocabularyDetails,
} from './library.types';

export class PostgresLibraryRepository implements LibraryRepository {
  constructor(private readonly pool: Pool) {}

  async upsertLicense(
    input: NormalizedLibraryLicenseInput,
    now = new Date(),
  ): Promise<LibraryLicenseRecord> {
    const result = await this.pool.query(
      `INSERT INTO library_licenses (
         license_key,
         display_name,
         canonical_url,
         attribution_required,
         redistribution_allowed,
         derivative_constraints,
         active,
         source_note,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT (license_key)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         canonical_url = EXCLUDED.canonical_url,
         attribution_required = EXCLUDED.attribution_required,
         redistribution_allowed = EXCLUDED.redistribution_allowed,
         derivative_constraints = EXCLUDED.derivative_constraints,
         active = EXCLUDED.active,
         source_note = EXCLUDED.source_note,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        input.licenseKey,
        input.displayName,
        input.canonicalUrl,
        input.attributionRequired,
        input.redistributionAllowed,
        input.derivativeConstraints,
        input.active,
        input.sourceNote,
        now,
      ],
    );
    return mapLicense(result.rows[0]);
  }

  async findLicense(licenseKey: string): Promise<LibraryLicenseRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM library_licenses WHERE license_key = $1',
      [licenseKey],
    );
    return result.rows[0] ? mapLicense(result.rows[0]) : null;
  }

  async listLicenses(): Promise<LibraryLicenseRecord[]> {
    const result = await this.pool.query(
      'SELECT * FROM library_licenses ORDER BY license_key ASC',
    );
    return result.rows.map(mapLicense);
  }

  async createResource(input: CreateLibraryResourceRepositoryInput): Promise<LibraryResourceRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO library_resources (
           resource_type,
           primary_language_id,
           secondary_language_id,
           cefr_level,
           created_by_user_id,
           visibility,
           created_at,
           updated_at
         )
         SELECT
           $1::library_resource_type,
           primary_language.id,
           secondary_language.id,
           $3::community_cefr_level,
           $4,
           $5::community_post_visibility,
           $6,
           $6
         FROM languages AS primary_language
         LEFT JOIN languages AS secondary_language
           ON secondary_language.code = $2
          AND secondary_language.active = true
         WHERE primary_language.code = $7
           AND primary_language.active = true
         RETURNING *`,
        [
          input.resourceType,
          input.secondaryLanguageCode,
          input.cefrLevel,
          input.createdByUserId,
          input.visibility,
          input.createdAt,
          input.primaryLanguageCode,
        ],
      );
      const row = inserted.rows[0];
      if (!row || (input.secondaryLanguageCode && !row.secondary_language_id)) {
        throw new LibraryRepositoryConflictError(
          'LIBRARY_LANGUAGE_UNAVAILABLE',
          'One or more library languages are unavailable',
        );
      }
      const resourceId = String(row.id);
      for (const topic of input.topics) {
        await client.query(
          'INSERT INTO library_resource_topics (resource_id, topic, created_at) VALUES ($1, $2, $3)',
          [resourceId, topic, input.createdAt],
        );
      }
      await this.insertDetails(client, resourceId, input.details);
      await client.query('COMMIT');
      const resource = await this.findResourceById(resourceId);
      if (!resource) throw new LibraryRepositoryConflictError('LIBRARY_RESOURCE_NOT_FOUND', 'Resource insert failed');
      return resource;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresError(error);
    } finally {
      client.release();
    }
  }

  async findResourceById(id: string): Promise<LibraryResourceRecord | null> {
    return this.findResourceWithExecutor(this.pool, id);
  }

  async searchPublicResources(
    input: LibrarySearchRepositoryInput,
  ): Promise<LibrarySearchRepositoryPage> {
    const values: unknown[] = [];
    const parameter = (value: unknown): string => {
      values.push(value);
      return '$' + values.length;
    };
    const filters = [
      `resource.visibility = 'PUBLIC'::community_post_visibility`,
      `resource.moderation_state = 'ACTIVE'::community_moderation_state`,
      `resource.review_state = 'VERIFIED'::library_review_state`,
      `EXISTS (
        SELECT 1
        FROM library_resource_provenance AS provenance_exists
        WHERE provenance_exists.resource_id = resource.id
      )`,
      `NOT EXISTS (
        SELECT 1
        FROM library_resource_provenance AS provenance_gate
        LEFT JOIN library_licenses AS license_gate
          ON license_gate.license_key = provenance_gate.license_key
        WHERE provenance_gate.resource_id = resource.id
          AND (
            license_gate.license_key IS NULL
            OR license_gate.active IS NOT TRUE
            OR license_gate.redistribution_allowed IS NOT TRUE
          )
      )`,
    ];

    if (input.filters.languageCode) {
      const languageParameter = parameter(input.filters.languageCode);
      filters.push(`(
        primary_language.code = ${languageParameter}
        OR secondary_language.code = ${languageParameter}
      )`);
    }
    if (input.filters.resourceType) {
      filters.push(`resource.resource_type = ${parameter(input.filters.resourceType)}::library_resource_type`);
    }
    if (input.filters.topic) {
      const topicParameter = parameter(input.filters.topic);
      filters.push(`EXISTS (
        SELECT 1
        FROM library_resource_topics AS topic_filter
        WHERE topic_filter.resource_id = resource.id
          AND topic_filter.topic = ${topicParameter}
      )`);
    }
    if (input.filters.cefrLevel) {
      filters.push(`resource.cefr_level = ${parameter(input.filters.cefrLevel)}::community_cefr_level`);
    }
    let keywordMatches = '';
    let keywordJoin = '';
    if (input.filters.q) {
      const qParameter = parameter('%' + escapeLikePattern(input.filters.q) + '%');
      const like = (column: string): string => `${column} ILIKE ${qParameter} ESCAPE E'\\\\'`;
      keywordMatches = `WITH keyword_matches AS MATERIALIZED (
        SELECT DISTINCT resource_id
        FROM (
          SELECT resource_id
          FROM library_resource_topics
          WHERE ${like('topic')}
          UNION ALL
          SELECT resource_id
          FROM library_vocabularies
          WHERE ${like('term')}
             OR ${like('definition')}
             OR ${like('part_of_speech')}
             OR ${like('example_sentence')}
          UNION ALL
          SELECT resource_id
          FROM library_sentences
          WHERE ${like('text_content')}
             OR ${like('context')}
          UNION ALL
          SELECT resource_id
          FROM library_translations
          WHERE ${like('source_text')}
             OR ${like('translated_text')}
          UNION ALL
          SELECT resource_id
          FROM library_grammar_items
          WHERE ${like('title')}
             OR ${like('explanation')}
             OR ${like('pattern')}
             OR ${like('example_text')}
          UNION ALL
          SELECT resource_id
          FROM library_dialogues
          WHERE ${like('title')}
             OR turns::text ILIKE ${qParameter} ESCAPE E'\\\\'
          UNION ALL
          SELECT resource_id
          FROM library_idioms
          WHERE ${like('expression')}
             OR ${like('meaning')}
             OR ${like('usage_note')}
          UNION ALL
          SELECT resource_id
          FROM library_slang
          WHERE ${like('expression')}
             OR ${like('meaning')}
             OR ${like('register')}
             OR ${like('usage_note')}
          UNION ALL
          SELECT resource_id
          FROM library_cultural_notes
          WHERE ${like('title')}
             OR ${like('body')}
          UNION ALL
          SELECT resource_id
          FROM library_pronunciations
          WHERE ${like('term')}
             OR ${like('phonetic')}
             OR ${like('notes')}
          UNION ALL
          SELECT resource_id
          FROM library_learning_collections
          WHERE ${like('title')}
             OR ${like('description')}
        ) AS keyword_candidates
      )`;
      keywordJoin = `INNER JOIN keyword_matches AS keyword_match
         ON keyword_match.resource_id = resource.id`;
    }
    if (input.cursor) {
      const cursorTimestamp = parameter(input.cursor.updatedAt);
      const cursorId = parameter(input.cursor.id);
      filters.push(`(
        resource.updated_at < ${cursorTimestamp}::timestamptz
        OR (resource.updated_at = ${cursorTimestamp}::timestamptz AND resource.id < ${cursorId}::uuid)
      )`);
    }

    const limitParameter = parameter(input.limit + 1);
    const result = await this.pool.query(
      `${keywordMatches ? keywordMatches + '\n' : ''}SELECT resource.id, resource.updated_at
       FROM library_resources AS resource
       ${keywordJoin ? keywordJoin + '\n       ' : ''}
       INNER JOIN languages AS primary_language ON primary_language.id = resource.primary_language_id
       LEFT JOIN languages AS secondary_language ON secondary_language.id = resource.secondary_language_id
       WHERE ${filters.join('\n         AND ')}
       ORDER BY resource.updated_at DESC, resource.id DESC
       LIMIT ${limitParameter}`,
      values,
    );
    const rows = result.rows.slice(0, input.limit + 1);
    const consumedRows = rows.slice(0, input.limit);
    const resources = await Promise.all(
      consumedRows.map((row) => this.findResourceById(String(row.id))),
    );
    const hasMore = rows.length > input.limit;
    const lastConsumedRow = consumedRows.at(-1);
    return {
      items: resources.filter((resource): resource is LibraryResourceRecord => Boolean(resource)),
      hasMore,
      nextBoundary: hasMore && lastConsumedRow
        ? {
          updatedAt: new Date(lastConsumedRow.updated_at),
          id: String(lastConsumedRow.id),
        }
        : null,
    };
  }

  async listReviewQueue(
    input: LibraryReviewQueueRepositoryInput,
  ): Promise<LibraryReviewQueueRepositoryPage> {
    const values: unknown[] = [];
    const parameter = (value: unknown): string => {
      values.push(value);
      return '$' + values.length;
    };
    const filters = [
      `resource.review_state = 'COMMUNITY_REVIEW'::library_review_state`,
    ];

    if (input.filters.languageCode) {
      const languageParameter = parameter(input.filters.languageCode);
      filters.push(`(
        primary_language.code = ${languageParameter}
        OR secondary_language.code = ${languageParameter}
      )`);
    }
    if (input.filters.resourceType) {
      filters.push(`resource.resource_type = ${parameter(input.filters.resourceType)}::library_resource_type`);
    }

    let keywordMatches = '';
    let keywordJoin = '';
    if (input.filters.q) {
      const qParameter = parameter('%' + escapeLikePattern(input.filters.q) + '%');
      const like = (column: string): string => `${column} ILIKE ${qParameter} ESCAPE E'\\\\'`;
      keywordMatches = `WITH keyword_matches AS MATERIALIZED (
        SELECT DISTINCT resource_id
        FROM (
          SELECT resource_id FROM library_resource_topics WHERE ${like('topic')}
          UNION ALL
          SELECT resource_id FROM library_vocabularies
           WHERE ${like('term')} OR ${like('definition')} OR ${like('part_of_speech')} OR ${like('example_sentence')}
          UNION ALL
          SELECT resource_id FROM library_sentences
           WHERE ${like('text_content')} OR ${like('context')}
          UNION ALL
          SELECT resource_id FROM library_translations
           WHERE ${like('source_text')} OR ${like('translated_text')}
          UNION ALL
          SELECT resource_id FROM library_grammar_items
           WHERE ${like('title')} OR ${like('explanation')} OR ${like('pattern')} OR ${like('example_text')}
          UNION ALL
          SELECT resource_id FROM library_dialogues
           WHERE ${like('title')} OR turns::text ILIKE ${qParameter} ESCAPE E'\\\\'
          UNION ALL
          SELECT resource_id FROM library_idioms
           WHERE ${like('expression')} OR ${like('meaning')} OR ${like('usage_note')}
          UNION ALL
          SELECT resource_id FROM library_slang
           WHERE ${like('expression')} OR ${like('meaning')} OR ${like('register')} OR ${like('usage_note')}
          UNION ALL
          SELECT resource_id FROM library_cultural_notes
           WHERE ${like('title')} OR ${like('body')}
          UNION ALL
          SELECT resource_id FROM library_pronunciations
           WHERE ${like('term')} OR ${like('phonetic')} OR ${like('notes')}
          UNION ALL
          SELECT resource_id FROM library_learning_collections
           WHERE ${like('title')} OR ${like('description')}
        ) AS keyword_candidates
      )`;
      keywordJoin = `INNER JOIN keyword_matches AS keyword_match
         ON keyword_match.resource_id = resource.id`;
    }
    if (input.cursor) {
      const cursorTimestamp = parameter(input.cursor.updatedAt);
      const cursorId = parameter(input.cursor.id);
      filters.push(`(
        resource.updated_at > ${cursorTimestamp}::timestamptz
        OR (resource.updated_at = ${cursorTimestamp}::timestamptz AND resource.id > ${cursorId}::uuid)
      )`);
    }

    const limitParameter = parameter(input.limit + 1);
    const result = await this.pool.query(
      `${keywordMatches ? keywordMatches + '\n' : ''}SELECT resource.id, resource.updated_at
       FROM library_resources AS resource
       ${keywordJoin ? keywordJoin + '\n       ' : ''}
       INNER JOIN languages AS primary_language ON primary_language.id = resource.primary_language_id
       LEFT JOIN languages AS secondary_language ON secondary_language.id = resource.secondary_language_id
       WHERE ${filters.join('\n         AND ')}
       ORDER BY resource.updated_at ASC, resource.id ASC
       LIMIT ${limitParameter}`,
      values,
    );
    const rows = result.rows.slice(0, input.limit + 1);
    const consumedRows = rows.slice(0, input.limit);
    const resources = await Promise.all(
      consumedRows.map((row) => this.findResourceById(String(row.id))),
    );
    const items = resources.filter((resource): resource is LibraryResourceRecord => (
      resource !== null && resource.reviewState === 'COMMUNITY_REVIEW'
    ));
    const hasMore = rows.length > input.limit;
    const lastConsumedRow = consumedRows.at(-1);
    return {
      items,
      hasMore,
      nextBoundary: hasMore && lastConsumedRow
        ? {
          updatedAt: new Date(lastConsumedRow.updated_at),
          id: String(lastConsumedRow.id),
        }
        : null,
    };
  }

  async listInvalidSourceQueue(
    input: LibraryInvalidSourceQueueRepositoryInput,
  ): Promise<LibraryReviewQueueRepositoryPage> {
    const values: unknown[] = [];
    const filters = [
      `resource.review_state = 'VERIFIED'::library_review_state`,
      `EXISTS (
        SELECT 1
        FROM library_resource_provenance AS phase06_provenance
        WHERE phase06_provenance.resource_id = resource.id
          AND phase06_provenance.source_type = 'PHASE06_LIBRARY_CANDIDATE'::library_source_type
      )`,
    ];
    if (input.cursor) {
      values.push(input.cursor.updatedAt, input.cursor.id);
      filters.push(`(
        resource.updated_at > $${values.length - 1}::timestamptz
        OR (resource.updated_at = $${values.length - 1}::timestamptz AND resource.id > $${values.length}::uuid)
      )`);
    }
    values.push(input.limit + 1);
    const result = await this.pool.query(
      `SELECT resource.id, resource.updated_at
       FROM library_resources AS resource
       WHERE ${filters.join('\n         AND ')}
       ORDER BY resource.updated_at ASC, resource.id ASC
       LIMIT $${values.length}`,
      values,
    );
    const rows = result.rows.slice(0, input.limit + 1);
    const consumedRows = rows.slice(0, input.limit);
    const resources = await Promise.all(
      consumedRows.map((row) => this.findResourceWithExecutor(this.pool, String(row.id))),
    );
    const items = resources.filter((resource): resource is LibraryResourceRecord => Boolean(resource));
    const hasMore = rows.length > input.limit;
    const lastConsumedRow = consumedRows.at(-1);
    return {
      items,
      hasMore,
      nextBoundary: hasMore && lastConsumedRow
        ? { updatedAt: new Date(lastConsumedRow.updated_at), id: String(lastConsumedRow.id) }
        : null,
    };
  }

  async addProvenance(
    resourceId: string,
    input: NormalizedLibraryProvenanceInput,
    expectation: LibraryProvenanceMutationExpectation,
    now = new Date(),
  ): Promise<LibraryProvenanceRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockAndValidateProvenanceMutation(client, resourceId, expectation);
      const result = await client.query(
        `INSERT INTO library_resource_provenance (
         resource_id,
         source_type,
         source_id,
         source_url,
         license_key,
         attribution,
         original_author_reference,
         original_contributor_user_id,
         import_batch,
         transformation_history,
         source_post_id,
         source_response_id,
         source_candidate_id,
         source_acceptance_id,
         created_at,
         updated_at
       )
       VALUES (
         $1,
         $2::library_source_type,
         $3,
         $4,
         $5,
         $6,
         $7,
         $8,
         $9,
         $10::jsonb,
         $11,
         $12,
         $13,
         $14,
         $15,
         $15
       )
       RETURNING *`,
        provenanceValues(resourceId, input, now),
      );
      await client.query('COMMIT');
      const license = await this.findLicense(input.licenseKey);
      if (!license) {
        throw new LibraryRepositoryConflictError('LIBRARY_LICENSE_UNKNOWN', 'Library license was not found');
      }
      return mapProvenance({ ...result.rows[0], license }, license);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresError(error);
    } finally {
      client.release();
    }
  }

  async mergeProvenance(
    resourceId: string,
    inputs: readonly NormalizedLibraryProvenanceInput[],
    expectation: LibraryProvenanceMutationExpectation,
    now = new Date(),
  ): Promise<LibraryProvenanceRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockAndValidateProvenanceMutation(client, resourceId, expectation);
      const existingResult = await client.query(
        provenanceSelect('WHERE provenance.resource_id = $1', true),
        [resourceId],
      );
      const existing = existingResult.rows.map((row) => mapProvenance(row, mapLicenseFromProvenanceRow(row)));
      let merged: NormalizedLibraryProvenanceInput[];
      try {
        merged = mergeNormalizedProvenanceEntries(existing.map(toNormalizedProvenance), inputs);
      } catch (error) {
        if (error instanceof LibraryValidationError && error.code === 'LIBRARY_PROVENANCE_DUPLICATE') {
          throw new LibraryRepositoryConflictError(
            error.code,
            'A provenance source conflicts with existing attribution',
          );
        }
        throw error;
      }
      const existingKeys = new Set(existing.map(provenanceKey));
      for (const entry of merged) {
        if (existingKeys.has(provenanceKey(entry))) continue;
        const licenseResult = await client.query(
          'SELECT * FROM library_licenses WHERE license_key = $1 FOR SHARE',
          [entry.licenseKey],
        );
        const license = licenseResult.rows[0] ? mapLicense(licenseResult.rows[0]) : null;
        if (!license) throw new LibraryRepositoryConflictError('LIBRARY_LICENSE_UNKNOWN', 'Library license was not found');
        if (!license.active) throw new LibraryRepositoryConflictError('LIBRARY_LICENSE_DISABLED', 'Library license is disabled');
        await client.query(
          `INSERT INTO library_resource_provenance (
             resource_id, source_type, source_id, source_url, license_key,
             attribution, original_author_reference, original_contributor_user_id,
             import_batch, transformation_history, source_post_id, source_response_id,
             source_candidate_id, source_acceptance_id, created_at, updated_at
           )
           VALUES ($1, $2::library_source_type, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $15)`,
          provenanceValues(resourceId, entry, now),
        );
      }
      await client.query('COMMIT');
      const resource = await this.findResourceById(resourceId);
      if (!resource) throw new LibraryRepositoryConflictError('LIBRARY_RESOURCE_NOT_FOUND', 'Library resource was not found');
      return resource.provenance;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresError(error);
    } finally {
      client.release();
    }
  }

  async transitionReview(
    input: TransitionLibraryReviewRepositoryInput,
  ): Promise<LibraryReviewTransitionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lockedResult = await client.query(
        `SELECT *
         FROM library_resources
         WHERE id = $1::uuid
         FOR UPDATE`,
        [input.resourceId],
      );
      const lockedRow = lockedResult.rows[0] as Record<string, unknown> | undefined;
      if (!lockedRow) {
        throw new LibraryRepositoryConflictError(
          'LIBRARY_RESOURCE_NOT_FOUND',
          'The library resource was not found',
        );
      }
      if (
        String(lockedRow.review_state) !== input.expectedPreviousState ||
        Number(lockedRow.provenance_revision) !== input.expectedProvenanceRevision
      ) {
        throw new LibraryRepositoryConflictError(
          'LIBRARY_REVIEW_CONFLICT',
          'The resource review state or provenance changed before this transition',
        );
      }
      if (input.action === 'VERIFY' || input.nextState === 'VERIFIED') {
        await this.validateVerificationEligibility(client, lockedRow);
      }
      const updated = await client.query(
        `UPDATE library_resources
         SET review_state = $3::library_review_state,
             reviewed_by_user_id = CASE
               WHEN $3::library_review_state IN ('VERIFIED'::library_review_state, 'REJECTED'::library_review_state)
               THEN $4::uuid
               ELSE NULL
             END,
             reviewed_at = CASE
               WHEN $3::library_review_state IN ('VERIFIED'::library_review_state, 'REJECTED'::library_review_state)
               THEN $5::timestamptz
               ELSE NULL
             END,
             updated_at = $5::timestamptz
         WHERE id = $1::uuid
           AND review_state = $2::library_review_state
           AND provenance_revision = $6::bigint
         RETURNING *`,
        [
          input.resourceId,
          input.expectedPreviousState,
          input.nextState,
          input.actorUserId,
          input.occurredAt,
          input.expectedProvenanceRevision,
        ],
      );
      if (!updated.rows[0]) {
        throw new LibraryRepositoryConflictError(
          'LIBRARY_REVIEW_CONFLICT',
          'The resource review state changed before this transition',
        );
      }
      const auditResult = await client.query(
        `INSERT INTO library_resource_review_audits (
           resource_id,
           actor_user_id,
           previous_state,
           new_state,
           action,
           note,
           created_at
         )
         VALUES ($1::uuid, $2::uuid, $3::library_review_state, $4::library_review_state, $5::library_review_action, $6, $7::timestamptz)
         RETURNING *`,
        [
          input.resourceId,
          input.actorUserId,
          input.expectedPreviousState,
          input.nextState,
          input.action,
          input.note,
          input.occurredAt,
        ],
      );
      const resource = await this.findResourceWithExecutor(client, input.resourceId);
      if (!resource) throw new LibraryRepositoryConflictError('LIBRARY_RESOURCE_NOT_FOUND', 'Library resource was not found');
      const audit = mapAudit(auditResult.rows[0]);
      await client.query('COMMIT');
      return {
        resource,
        audit,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresError(error);
    } finally {
      client.release();
    }
  }

  async reconcileSource(
    input: ReconcileLibrarySourceRepositoryInput,
  ): Promise<LibraryReviewTransitionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lockedResult = await client.query(
        `SELECT *
         FROM library_resources
         WHERE id = $1::uuid
         FOR UPDATE`,
        [input.resourceId],
      );
      const lockedRow = lockedResult.rows[0] as Record<string, unknown> | undefined;
      if (!lockedRow) {
        throw new LibraryRepositoryConflictError(
          'LIBRARY_RESOURCE_NOT_FOUND',
          'The library resource was not found',
        );
      }
      if (
        String(lockedRow.review_state) !== input.expectedPreviousState ||
        Number(lockedRow.provenance_revision) !== input.expectedProvenanceRevision
      ) {
        throw new LibraryRepositoryConflictError(
          'LIBRARY_REVIEW_CONFLICT',
          'The resource review state or provenance changed before source reconciliation',
        );
      }

      const provenanceRows = await this.readLockedProvenanceRows(client, input.resourceId);
      const sourceHealth = await this.lockAndEvaluatePhase06Sources(client, provenanceRows);
      const invalidReasons = sourceHealth
        .filter((entry) => !entry.health.valid)
        .map((entry) => entry.health.reason);
      if (invalidReasons.length === 0) {
        throw new LibraryRepositoryConflictError(
          'LIBRARY_SOURCE_STILL_VALID',
          'The Phase 06 source is currently valid',
        );
      }

      const updated = await client.query(
        `UPDATE library_resources
         SET review_state = 'COMMUNITY_REVIEW'::library_review_state,
             reviewed_by_user_id = NULL,
             reviewed_at = NULL,
             updated_at = $2::timestamptz
         WHERE id = $1::uuid
           AND review_state = 'VERIFIED'::library_review_state
           AND provenance_revision = $3::bigint
         RETURNING *`,
        [input.resourceId, input.occurredAt, input.expectedProvenanceRevision],
      );
      if (!updated.rows[0]) {
        throw new LibraryRepositoryConflictError(
          'LIBRARY_REVIEW_CONFLICT',
          'The resource review state changed before source reconciliation',
        );
      }

      const auditResult = await client.query(
        `INSERT INTO library_resource_review_audits (
           resource_id,
           actor_user_id,
           previous_state,
           new_state,
           action,
           note,
           created_at
         )
         VALUES ($1::uuid, $2::uuid, 'VERIFIED'::library_review_state, 'COMMUNITY_REVIEW'::library_review_state, 'INVALIDATE'::library_review_action, $3, $4::timestamptz)
         RETURNING *`,
        [
          input.resourceId,
          input.actorUserId,
          formatLibrarySourceInvalidationNote(invalidReasons, input.note),
          input.occurredAt,
        ],
      );
      const resource = await this.findResourceWithExecutor(client, input.resourceId);
      if (!resource) {
        throw new LibraryRepositoryConflictError(
          'LIBRARY_RESOURCE_NOT_FOUND',
          'Library resource was not found after source reconciliation',
        );
      }
      const audit = mapAudit(auditResult.rows[0]);
      await client.query('COMMIT');
      return { resource, audit };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresError(error);
    } finally {
      client.release();
    }
  }

  private async validateVerificationEligibility(
    client: PoolClient,
    resourceRow: Record<string, unknown>,
  ): Promise<void> {
    if (String(resourceRow.moderation_state) !== 'ACTIVE') {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_REVIEW_MODERATION_INACTIVE',
        'Only actively moderated resources can be verified',
      );
    }
    const provenanceRows = await this.readLockedProvenanceRows(client, String(resourceRow.id));
    if (provenanceRows.length === 0) {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_PROVENANCE_REQUIRED',
        'A resource needs provenance before verification',
      );
    }

    const licenseKeys = [...new Set(provenanceRows.map((row) => String(row.license_key)))].sort();
    const licenseResult = await client.query(
      `SELECT license_key, active, redistribution_allowed
       FROM library_licenses
       WHERE license_key = ANY($1::varchar[])
       ORDER BY license_key ASC
       FOR SHARE`,
      [licenseKeys],
    );
    const licenses = new Map(
      licenseResult.rows.map((row) => [String(row.license_key), row as Record<string, unknown>]),
    );
    for (const provenance of provenanceRows) {
      const license = licenses.get(String(provenance.license_key));
      if (!license) {
        throw new LibraryRepositoryConflictError(
          'LIBRARY_LICENSE_UNKNOWN',
          'A resource references an unknown license',
        );
      }
      if (license.active !== true) {
        throw new LibraryRepositoryConflictError(
          'LIBRARY_LICENSE_DISABLED',
          'A resource references a disabled license',
        );
      }
      if (
        String(resourceRow.visibility) === 'PUBLIC' &&
        license.redistribution_allowed !== true
      ) {
        throw new LibraryRepositoryConflictError(
          'LIBRARY_LICENSE_REDISTRIBUTION_REQUIRED',
          'A public resource requires explicit redistribution permission for every license',
        );
      }
    }

    const sourceHealth = await this.lockAndEvaluatePhase06Sources(client, provenanceRows);
    const invalidSource = sourceHealth.find((entry) => !entry.health.valid);
    if (invalidSource) {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_SOURCE_INVALID',
        'A Phase 06 source is no longer eligible for verification',
      );
    }
  }

  private async readLockedProvenanceRows(
    client: PoolClient,
    resourceId: string,
  ): Promise<Record<string, unknown>[]> {
    const result = await client.query(
      `SELECT id, source_type, source_id, source_post_id, source_response_id,
              source_candidate_id, source_acceptance_id, license_key
       FROM library_resource_provenance
       WHERE resource_id = $1::uuid
       ORDER BY id ASC
       FOR SHARE`,
      [resourceId],
    );
    return result.rows as Record<string, unknown>[];
  }

  private async lockAndEvaluatePhase06Sources(
    client: PoolClient,
    provenanceRows: readonly Record<string, unknown>[],
  ): Promise<Array<{ provenance: Record<string, unknown>; health: Phase06SourceHealth }>> {
    const phase06Rows = provenanceRows
      .filter((row) => String(row.source_type) === 'PHASE06_LIBRARY_CANDIDATE')
      .sort((left, right) => String(left.source_candidate_id ?? '').localeCompare(String(right.source_candidate_id ?? '')));
    if (phase06Rows.length === 0) return [];

    const postIds = [...new Set(phase06Rows.map((row) => String(row.source_post_id ?? '')).filter(Boolean))].sort();
    const responseIds = [...new Set(phase06Rows.map((row) => String(row.source_response_id ?? '')).filter(Boolean))].sort();
    const acceptanceIds = [...new Set(phase06Rows.map((row) => String(row.source_acceptance_id ?? '')).filter(Boolean))].sort();
    const candidateIds = [...new Set(phase06Rows.map((row) => String(row.source_candidate_id ?? '')).filter(Boolean))].sort();

    // Source mutations in Phase 06 acquire parent, response, acceptance, then
    // candidate locks. Keep the same order here to produce a coherent race.
    const postRows = postIds.length === 0 ? [] : (await client.query(
      `SELECT id, moderation_state, visibility
       FROM community_posts
       WHERE id = ANY($1::uuid[])
       ORDER BY id ASC
       FOR SHARE`,
      [postIds],
    )).rows as Record<string, unknown>[];
    const responseRows = responseIds.length === 0 ? [] : (await client.query(
      `SELECT id, parent_post_id, moderation_state
       FROM community_structured_responses
       WHERE id = ANY($1::uuid[])
       ORDER BY id ASC
       FOR SHARE`,
      [responseIds],
    )).rows as Record<string, unknown>[];
    const acceptanceRows = (await client.query(
      `SELECT id, parent_post_id, response_id, revoked_at
       FROM community_structured_response_acceptances
       WHERE id = ANY($1::uuid[])
          OR (parent_post_id = ANY($2::uuid[]) AND revoked_at IS NULL)
       ORDER BY id ASC
       FOR SHARE`,
      [acceptanceIds, postIds],
    )).rows as Record<string, unknown>[];
    const candidateRows = candidateIds.length === 0 ? [] : (await client.query(
      `SELECT id, state, source_post_id, source_response_id, acceptance_id
       FROM community_library_candidates
       WHERE id = ANY($1::uuid[])
       ORDER BY id ASC
       FOR SHARE`,
      [candidateIds],
    )).rows as Record<string, unknown>[];

    const posts = new Map(postRows.map((row) => [String(row.id), row]));
    const responses = new Map(responseRows.map((row) => [String(row.id), row]));
    const candidates = new Map(candidateRows.map((row) => [String(row.id), row]));
    const acceptances = new Map(acceptanceRows.map((row) => [String(row.id), row]));
    const activeAcceptances = new Map(
      acceptanceRows
        .filter((row) => row.revoked_at === null || row.revoked_at === undefined)
        .map((row) => [String(row.parent_post_id), row]),
    );

    return phase06Rows.map((provenance) => {
      const sourcePostId = String(provenance.source_post_id ?? '');
      const sourceResponseId = String(provenance.source_response_id ?? '');
      const sourceCandidateId = String(provenance.source_candidate_id ?? '');
      const sourceAcceptanceId = String(provenance.source_acceptance_id ?? '');
      const reference: Phase06SourceReference = {
        sourceId: String(provenance.source_id ?? ''),
        sourcePostId,
        sourceResponseId,
        sourceCandidateId,
        sourceAcceptanceId,
      };
      const candidate = candidates.get(sourceCandidateId);
      const post = posts.get(sourcePostId);
      const response = responses.get(sourceResponseId);
      const acceptance = acceptances.get(sourceAcceptanceId);
      const currentAcceptance = activeAcceptances.get(sourcePostId);
      const row: Phase06SourceHealthRow | null = candidate
        ? {
          candidateId: String(candidate.id),
          candidateState: String(candidate.state),
          candidateSourcePostId: String(candidate.source_post_id),
          candidateSourceResponseId: String(candidate.source_response_id),
          candidateAcceptanceId: String(candidate.acceptance_id),
          postExists: Boolean(post),
          postModerationState: post?.moderation_state ? String(post.moderation_state) : null,
          postVisibility: post?.visibility ? String(post.visibility) : null,
          responseExists: Boolean(response),
          responseParentPostId: response?.parent_post_id ? String(response.parent_post_id) : null,
          responseModerationState: response?.moderation_state ? String(response.moderation_state) : null,
          acceptanceExists: Boolean(acceptance),
          acceptanceParentPostId: acceptance?.parent_post_id ? String(acceptance.parent_post_id) : null,
          acceptanceResponseId: acceptance?.response_id ? String(acceptance.response_id) : null,
          acceptanceRevokedAt: acceptance?.revoked_at ? new Date(String(acceptance.revoked_at)).toISOString() : null,
          currentAcceptanceId: currentAcceptance?.id ? String(currentAcceptance.id) : null,
          currentAcceptanceResponseId: currentAcceptance?.response_id
            ? String(currentAcceptance.response_id)
            : null,
        }
        : null;
      return {
        provenance,
        health: evaluatePhase06SourceHealth(reference, row),
      };
    });
  }

  async submitContribution(
    input: SubmitLibraryContributionRepositoryInput,
  ): Promise<LibraryContributionSubmissionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE library_resources
         SET review_state = 'COMMUNITY_REVIEW'::library_review_state,
             reviewed_by_user_id = NULL,
             reviewed_at = NULL,
             updated_at = $2::timestamptz
         WHERE id = $1::uuid
           AND created_by_user_id = $3::uuid
           AND resource_type = $4::library_resource_type
           AND visibility = 'PUBLIC'::community_post_visibility
           AND moderation_state = 'ACTIVE'::community_moderation_state
           AND review_state = 'DRAFT'::library_review_state
           AND provenance_revision = $5::bigint
         RETURNING *`,
        [
          input.resourceId,
          input.occurredAt,
          input.contributorUserId,
          input.resourceType,
          input.expectedProvenanceRevision,
        ],
      );
      if (!updated.rows[0]) {
        throw new LibraryRepositoryConflictError(
          'LIBRARY_CONTRIBUTION_CONFLICT',
          'The library contribution is no longer an editable draft',
        );
      }

      const provenanceResult = await client.query(
        `SELECT source_type, original_contributor_user_id, license_key
         FROM library_resource_provenance
         WHERE resource_id = $1::uuid
         ORDER BY id ASC
         FOR SHARE`,
        [input.resourceId],
      );
      const provenanceRows = provenanceResult.rows as Record<string, unknown>[];
      if (provenanceRows.length === 0) {
        throw new LibraryRepositoryConflictError(
          'LIBRARY_PROVENANCE_REQUIRED',
          'A contribution requires provenance before submission',
        );
      }

      const licenseKeys = [...new Set(provenanceRows.map((row) => String(row.license_key)))].sort();
      const licenseResult = await client.query(
        `SELECT license_key, active, redistribution_allowed
         FROM library_licenses
         WHERE license_key = ANY($1::varchar[])
         ORDER BY license_key ASC
         FOR SHARE`,
        [licenseKeys],
      );
      const licenses = new Map(
        licenseResult.rows.map((row) => [String(row.license_key), row as Record<string, unknown>]),
      );
      for (const provenance of provenanceRows) {
        if (
          String(provenance.source_type) !== 'ORIGINAL_AUTHOR' ||
          String(provenance.original_contributor_user_id ?? '') !== input.contributorUserId
        ) {
          throw new LibraryRepositoryConflictError(
            'LIBRARY_CONTRIBUTION_PROVENANCE_FORBIDDEN',
            'Every contribution provenance entry must be bound to the authenticated original contributor',
          );
        }
        const license = licenses.get(String(provenance.license_key));
        if (!license) {
          throw new LibraryRepositoryConflictError(
            'LIBRARY_LICENSE_UNKNOWN',
            'A contribution references an unknown license',
          );
        }
        if (license.active !== true) {
          throw new LibraryRepositoryConflictError(
            'LIBRARY_LICENSE_DISABLED',
            'A contribution references a disabled license',
          );
        }
        if (license.redistribution_allowed !== true) {
          throw new LibraryRepositoryConflictError(
            'LIBRARY_LICENSE_REDISTRIBUTION_REQUIRED',
            'A contribution requires explicit redistribution permission for every license',
          );
        }
      }

      const auditResult = await client.query(
        `INSERT INTO library_resource_review_audits (
           resource_id,
           actor_user_id,
           previous_state,
           new_state,
           action,
           note,
           created_at
         )
         VALUES ($1::uuid, $2::uuid, 'DRAFT'::library_review_state, 'COMMUNITY_REVIEW'::library_review_state, 'SUBMIT'::library_review_action, NULL, $3::timestamptz)
         RETURNING *`,
        [input.resourceId, input.contributorUserId, input.occurredAt],
      );
      const audit = mapAudit(auditResult.rows[0]);
      const eventResult = await client.query(
        `INSERT INTO library_contribution_events (
           event_type,
           event_version,
           resource_id,
           contributor_user_id,
           review_audit_id,
           resource_type,
           terms_version,
           rights_confirmed,
           reuse_consent,
           occurred_at
         )
         VALUES (
           'LIBRARY_CONTRIBUTION_SUBMITTED'::library_contribution_event_type,
           1,
           $1::uuid,
           $2::uuid,
           $3::uuid,
           $4::library_resource_type,
           $5,
           $6::boolean,
           $7::boolean,
           $8::timestamptz
         )
         RETURNING *`,
        [
          input.resourceId,
          input.contributorUserId,
          audit.id,
          input.resourceType,
          input.termsVersion,
          input.rightsConfirmed,
          input.reuseConsent,
          input.occurredAt,
        ],
      );
      const event = mapContributionEvent(eventResult.rows[0]);
      const resource = await this.findResourceWithExecutor(client, input.resourceId);
      if (!resource) {
        throw new LibraryRepositoryConflictError(
          'LIBRARY_RESOURCE_NOT_FOUND',
          'Library resource was not found after contribution submission',
        );
      }

      await client.query('COMMIT');
      return {
        resource,
        audit,
        event,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresError(error);
    } finally {
      client.release();
    }
  }

  async listReviewAudit(resourceId: string): Promise<LibraryReviewAuditRecord[]> {
    const result = await this.pool.query(
      `SELECT *
       FROM library_resource_review_audits
       WHERE resource_id = $1
       ORDER BY created_at ASC, id ASC`,
      [resourceId],
    );
    return result.rows.map(mapAudit);
  }

  async listContributionEvents(resourceId?: string): Promise<LibraryContributionEventRecord[]> {
    const result = await this.pool.query(
      `SELECT *
       FROM library_contribution_events
       ${resourceId ? 'WHERE resource_id = $1::uuid' : ''}
       ORDER BY occurred_at ASC, id ASC`,
      resourceId ? [resourceId] : [],
    );
    return result.rows.map(mapContributionEvent);
  }

  private async findResourceWithExecutor(
    executor: Pool | PoolClient,
    id: string,
  ): Promise<LibraryResourceRecord | null> {
    const baseResult = await executor.query(
      `SELECT
         resource.*,
         primary_language.code AS primary_language_code,
         secondary_language.code AS secondary_language_code
       FROM library_resources AS resource
       INNER JOIN languages AS primary_language ON primary_language.id = resource.primary_language_id
       LEFT JOIN languages AS secondary_language ON secondary_language.id = resource.secondary_language_id
       WHERE resource.id = $1`,
      [id],
    );
    const row = baseResult.rows[0];
    if (!row) return null;
    const [topicsResult, provenanceResult, details] = await Promise.all([
      executor.query(
        'SELECT topic FROM library_resource_topics WHERE resource_id = $1 ORDER BY topic ASC',
        [id],
      ),
      executor.query(
        provenanceSelect('WHERE provenance.resource_id = $1', false),
        [id],
      ),
      this.loadDetails(executor, id, String(row.resource_type)),
    ]);
    return mapResource(
      row,
      topicsResult.rows.map((topic) => String(topic.topic)),
      provenanceResult.rows.map((provenance) => mapProvenance(provenance, mapLicenseFromProvenanceRow(provenance))),
      details,
    );
  }

  private async insertDetails(
    client: PoolClient,
    resourceId: string,
    details: LibraryResourceDetails,
  ): Promise<void> {
    switch (details.resourceType) {
      case 'VOCABULARY':
        await client.query(
          `INSERT INTO library_vocabularies (resource_id, term, definition, part_of_speech, example_sentence)
           VALUES ($1, $2, $3, $4, $5)`,
          [resourceId, details.term, details.definition, details.partOfSpeech, details.exampleSentence],
        );
        return;
      case 'SENTENCE':
        await client.query(
          'INSERT INTO library_sentences (resource_id, text_content, context) VALUES ($1, $2, $3)',
          [resourceId, details.text, details.context],
        );
        return;
      case 'TRANSLATION':
        await client.query(
          'INSERT INTO library_translations (resource_id, source_text, translated_text) VALUES ($1, $2, $3)',
          [resourceId, details.sourceText, details.translatedText],
        );
        return;
      case 'GRAMMAR_ITEM':
        await client.query(
          `INSERT INTO library_grammar_items (resource_id, title, explanation, pattern, example_text)
           VALUES ($1, $2, $3, $4, $5)`,
          [resourceId, details.title, details.explanation, details.pattern, details.exampleText],
        );
        return;
      case 'DIALOGUE':
        await client.query(
          'INSERT INTO library_dialogues (resource_id, title, turns) VALUES ($1, $2, $3::jsonb)',
          [resourceId, details.title, JSON.stringify(details.turns)],
        );
        return;
      case 'IDIOM':
        await client.query(
          'INSERT INTO library_idioms (resource_id, expression, meaning, usage_note) VALUES ($1, $2, $3, $4)',
          [resourceId, details.expression, details.meaning, details.usageNote],
        );
        return;
      case 'SLANG':
        await client.query(
          'INSERT INTO library_slang (resource_id, expression, meaning, register, usage_note) VALUES ($1, $2, $3, $4, $5)',
          [resourceId, details.expression, details.meaning, details.register, details.usageNote],
        );
        return;
      case 'CULTURAL_NOTE':
        await client.query(
          'INSERT INTO library_cultural_notes (resource_id, title, body) VALUES ($1, $2, $3)',
          [resourceId, details.title, details.body],
        );
        return;
      case 'PRONUNCIATION':
        await client.query(
          'INSERT INTO library_pronunciations (resource_id, term, phonetic, notes) VALUES ($1, $2, $3, $4)',
          [resourceId, details.term, details.phonetic, details.notes],
        );
        return;
      case 'LEARNING_COLLECTION':
        await client.query(
          'INSERT INTO library_learning_collections (resource_id, title, description) VALUES ($1, $2, $3)',
          [resourceId, details.title, details.description],
        );
        return;
    }
  }

  private async loadDetails(
    executor: Pool | PoolClient,
    resourceId: string,
    resourceType: string,
  ): Promise<LibraryResourceDetails> {
    const queries: Record<string, string> = {
      VOCABULARY: 'SELECT term, definition, part_of_speech, example_sentence FROM library_vocabularies WHERE resource_id = $1',
      SENTENCE: 'SELECT text_content, context FROM library_sentences WHERE resource_id = $1',
      TRANSLATION: 'SELECT source_text, translated_text FROM library_translations WHERE resource_id = $1',
      GRAMMAR_ITEM: 'SELECT title, explanation, pattern, example_text FROM library_grammar_items WHERE resource_id = $1',
      DIALOGUE: 'SELECT title, turns FROM library_dialogues WHERE resource_id = $1',
      IDIOM: 'SELECT expression, meaning, usage_note FROM library_idioms WHERE resource_id = $1',
      SLANG: 'SELECT expression, meaning, register, usage_note FROM library_slang WHERE resource_id = $1',
      CULTURAL_NOTE: 'SELECT title, body FROM library_cultural_notes WHERE resource_id = $1',
      PRONUNCIATION: 'SELECT term, phonetic, notes FROM library_pronunciations WHERE resource_id = $1',
      LEARNING_COLLECTION: 'SELECT title, description FROM library_learning_collections WHERE resource_id = $1',
    };
    const query = queries[resourceType];
    if (!query) throw new LibraryRepositoryConflictError('LIBRARY_RESOURCE_TYPE_INVALID', 'Library resource type is invalid');
    const result = await executor.query(query, [resourceId]);
    if (!result.rows[0]) throw new LibraryRepositoryConflictError('LIBRARY_RESOURCE_DETAILS_MISSING', 'Library resource details are missing');
    return mapDetails(resourceType, result.rows[0]);
  }

  private async lockAndValidateProvenanceMutation(
    client: PoolClient,
    resourceId: string,
    expectation: LibraryProvenanceMutationExpectation,
  ): Promise<void> {
    const result = await client.query(
      `SELECT review_state, provenance_revision
       FROM library_resources
       WHERE id = $1
       FOR UPDATE`,
      [resourceId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_RESOURCE_NOT_FOUND',
        'Library resource was not found',
      );
    }
    if (row.review_state !== 'DRAFT' && row.review_state !== 'COMMUNITY_REVIEW') {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_PROVENANCE_IMMUTABLE',
        'Provenance cannot be changed in the current review state',
      );
    }
    if (
      row.review_state !== expectation.expectedReviewState ||
      Number(row.provenance_revision) !== expectation.expectedProvenanceRevision
    ) {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_REVIEW_CONFLICT',
        'The resource review state or provenance changed before this mutation',
      );
    }
  }
}

function provenanceSelect(where: string, lock: boolean): string {
  return `SELECT
    provenance.*,
    license.display_name AS license_display_name,
    license.canonical_url AS license_canonical_url,
    license.attribution_required AS license_attribution_required,
    license.redistribution_allowed AS license_redistribution_allowed,
    license.derivative_constraints AS license_derivative_constraints,
    license.active AS license_active,
    license.source_note AS license_source_note,
    license.created_at AS license_created_at,
    license.updated_at AS license_updated_at
  FROM library_resource_provenance AS provenance
  INNER JOIN library_licenses AS license ON license.license_key = provenance.license_key
  ${where}
  ORDER BY provenance.created_at ASC, provenance.id ASC${lock ? ' FOR UPDATE OF provenance' : ''}`;
}

function provenanceValues(
  resourceId: string,
  input: NormalizedLibraryProvenanceInput,
  now: Date,
): unknown[] {
  return [
    resourceId,
    input.sourceType,
    input.sourceId,
    input.sourceUrl,
    input.licenseKey,
    input.attribution,
    input.originalAuthorReference,
    input.originalContributorUserId,
    input.importBatch,
    JSON.stringify(input.transformationHistory),
    input.sourcePostId,
    input.sourceResponseId,
    input.sourceCandidateId,
    input.sourceAcceptanceId,
    now,
  ];
}

function mapLicense(row: Record<string, unknown>): LibraryLicenseRecord {
  return {
    licenseKey: String(row.license_key),
    displayName: String(row.display_name),
    canonicalUrl: String(row.canonical_url),
    attributionRequired: Boolean(row.attribution_required),
    redistributionAllowed: row.redistribution_allowed === null || row.redistribution_allowed === undefined
      ? null
      : Boolean(row.redistribution_allowed),
    derivativeConstraints: row.derivative_constraints ? String(row.derivative_constraints) : null,
    active: Boolean(row.active),
    sourceNote: row.source_note ? String(row.source_note) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function mapLicenseFromProvenanceRow(row: Record<string, unknown>): LibraryLicenseRecord {
  return {
    licenseKey: String(row.license_key),
    displayName: String(row.license_display_name),
    canonicalUrl: String(row.license_canonical_url),
    attributionRequired: Boolean(row.license_attribution_required),
    redistributionAllowed: row.license_redistribution_allowed === null || row.license_redistribution_allowed === undefined
      ? null
      : Boolean(row.license_redistribution_allowed),
    derivativeConstraints: row.license_derivative_constraints ? String(row.license_derivative_constraints) : null,
    active: Boolean(row.license_active),
    sourceNote: row.license_source_note ? String(row.license_source_note) : null,
    createdAt: new Date(String(row.license_created_at)),
    updatedAt: new Date(String(row.license_updated_at)),
  };
}

function mapProvenance(
  row: Record<string, unknown>,
  license: LibraryLicenseRecord,
): LibraryProvenanceRecord {
  return {
    id: String(row.id),
    resourceId: String(row.resource_id),
    sourceType: String(row.source_type) as LibraryProvenanceRecord['sourceType'],
    sourceId: String(row.source_id),
    sourceUrl: row.source_url ? String(row.source_url) : null,
    licenseKey: String(row.license_key),
    attribution: String(row.attribution),
    originalAuthorReference: row.original_author_reference ? String(row.original_author_reference) : null,
    originalContributorUserId: row.original_contributor_user_id ? String(row.original_contributor_user_id) : null,
    importBatch: row.import_batch ? String(row.import_batch) : null,
    transformationHistory: parseTransformationHistory(row.transformation_history),
    sourcePostId: row.source_post_id ? String(row.source_post_id) : null,
    sourceResponseId: row.source_response_id ? String(row.source_response_id) : null,
    sourceCandidateId: row.source_candidate_id ? String(row.source_candidate_id) : null,
    sourceAcceptanceId: row.source_acceptance_id ? String(row.source_acceptance_id) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    license,
  };
}

function mapResource(
  row: Record<string, unknown>,
  topics: string[],
  provenance: LibraryProvenanceRecord[],
  details: LibraryResourceDetails,
): LibraryResourceRecord {
  return {
    id: String(row.id),
    resourceType: String(row.resource_type) as LibraryResourceRecord['resourceType'],
    primaryLanguageCode: String(row.primary_language_code),
    secondaryLanguageCode: row.secondary_language_code ? String(row.secondary_language_code) : null,
    cefrLevel: row.cefr_level ? String(row.cefr_level) as LibraryResourceRecord['cefrLevel'] : null,
    topics,
    createdByUserId: String(row.created_by_user_id),
    visibility: String(row.visibility) as LibraryResourceRecord['visibility'],
    moderationState: String(row.moderation_state) as LibraryResourceRecord['moderationState'],
    reviewState: String(row.review_state) as LibraryResourceRecord['reviewState'],
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    reviewedByUserId: row.reviewed_by_user_id ? String(row.reviewed_by_user_id) : null,
    reviewedAt: row.reviewed_at ? new Date(String(row.reviewed_at)) : null,
    provenanceRevision: Number(row.provenance_revision ?? 0),
    details,
    provenance,
  };
}

function mapDetails(resourceType: string, row: Record<string, unknown>): LibraryResourceDetails {
  switch (resourceType) {
    case 'VOCABULARY':
      return {
        resourceType,
        term: String(row.term),
        definition: String(row.definition),
        partOfSpeech: row.part_of_speech ? String(row.part_of_speech) : null,
        exampleSentence: row.example_sentence ? String(row.example_sentence) : null,
      } satisfies VocabularyDetails & { resourceType: 'VOCABULARY' };
    case 'SENTENCE':
      return {
        resourceType,
        text: String(row.text_content),
        context: row.context ? String(row.context) : null,
      } satisfies SentenceDetails & { resourceType: 'SENTENCE' };
    case 'TRANSLATION':
      return {
        resourceType,
        sourceText: String(row.source_text),
        translatedText: String(row.translated_text),
      } satisfies TranslationDetails & { resourceType: 'TRANSLATION' };
    case 'GRAMMAR_ITEM':
      return {
        resourceType,
        title: String(row.title),
        explanation: String(row.explanation),
        pattern: row.pattern ? String(row.pattern) : null,
        exampleText: row.example_text ? String(row.example_text) : null,
      } satisfies GrammarItemDetails & { resourceType: 'GRAMMAR_ITEM' };
    case 'DIALOGUE':
      return {
        resourceType,
        title: String(row.title),
        turns: parseDialogueTurns(row.turns),
      } satisfies DialogueDetails & { resourceType: 'DIALOGUE' };
    case 'IDIOM':
      return {
        resourceType,
        expression: String(row.expression),
        meaning: String(row.meaning),
        usageNote: row.usage_note ? String(row.usage_note) : null,
      } satisfies IdiomDetails & { resourceType: 'IDIOM' };
    case 'SLANG':
      return {
        resourceType,
        expression: String(row.expression),
        meaning: String(row.meaning),
        register: row.register ? String(row.register) : null,
        usageNote: row.usage_note ? String(row.usage_note) : null,
      } satisfies SlangDetails & { resourceType: 'SLANG' };
    case 'CULTURAL_NOTE':
      return {
        resourceType,
        title: String(row.title),
        body: String(row.body),
      } satisfies CulturalNoteDetails & { resourceType: 'CULTURAL_NOTE' };
    case 'PRONUNCIATION':
      return {
        resourceType,
        term: String(row.term),
        phonetic: String(row.phonetic),
        notes: row.notes ? String(row.notes) : null,
      } satisfies PronunciationDetails & { resourceType: 'PRONUNCIATION' };
    case 'LEARNING_COLLECTION':
      return {
        resourceType,
        title: String(row.title),
        description: String(row.description),
      } satisfies LearningCollectionDetails & { resourceType: 'LEARNING_COLLECTION' };
    default:
      throw new LibraryRepositoryConflictError('LIBRARY_RESOURCE_TYPE_INVALID', 'Library resource type is invalid');
  }
}

function parseDialogueTurns(input: unknown): DialogueDetails['turns'] {
  const value = parseJson(input);
  if (!Array.isArray(value)) throw new LibraryRepositoryConflictError('LIBRARY_RESOURCE_DETAILS_INVALID', 'Dialogue turns are invalid');
  return value.map((turn) => {
    if (typeof turn !== 'object' || turn === null) {
      throw new LibraryRepositoryConflictError('LIBRARY_RESOURCE_DETAILS_INVALID', 'Dialogue turns are invalid');
    }
    const record = turn as Record<string, unknown>;
    return {
      speaker: String(record.speaker),
      text: String(record.text),
      translation: record.translation ? String(record.translation) : null,
    };
  });
}

function parseTransformationHistory(input: unknown): LibraryProvenanceRecord['transformationHistory'] {
  const value = parseJson(input);
  return Array.isArray(value) ? value.map((entry) => entry as LibraryProvenanceRecord['transformationHistory'][number]) : [];
}

function parseJson(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function toNormalizedProvenance(record: LibraryProvenanceRecord): NormalizedLibraryProvenanceInput {
  return {
    sourceType: record.sourceType,
    sourceId: record.sourceId,
    sourceUrl: record.sourceUrl,
    licenseKey: record.licenseKey,
    attribution: record.attribution,
    originalAuthorReference: record.originalAuthorReference,
    originalContributorUserId: record.originalContributorUserId,
    importBatch: record.importBatch,
    transformationHistory: record.transformationHistory,
    sourcePostId: record.sourcePostId,
    sourceResponseId: record.sourceResponseId,
    sourceCandidateId: record.sourceCandidateId,
    sourceAcceptanceId: record.sourceAcceptanceId,
  };
}

function provenanceKey(entry: Pick<NormalizedLibraryProvenanceInput, 'sourceType' | 'sourceId'>): string {
  return entry.sourceType + ':' + entry.sourceId;
}

function mapAudit(row: Record<string, unknown>): LibraryReviewAuditRecord {
  return {
    id: String(row.id),
    resourceId: String(row.resource_id),
    actorUserId: String(row.actor_user_id),
    previousState: String(row.previous_state) as LibraryReviewAuditRecord['previousState'],
    newState: String(row.new_state) as LibraryReviewAuditRecord['newState'],
    action: String(row.action) as LibraryReviewAuditRecord['action'],
    note: row.note ? String(row.note) : null,
    createdAt: new Date(String(row.created_at)),
  };
}

function mapContributionEvent(row: Record<string, unknown>): LibraryContributionEventRecord {
  return {
    id: String(row.id),
    eventType: 'LIBRARY_CONTRIBUTION_SUBMITTED',
    eventVersion: Number(row.event_version) as 1,
    resourceId: String(row.resource_id),
    contributorUserId: String(row.contributor_user_id),
    reviewAuditId: String(row.review_audit_id),
    resourceType: String(row.resource_type) as LibraryContributionEventRecord['resourceType'],
    termsVersion: String(row.terms_version) as 'library-contribution-v1',
    rightsConfirmed: row.rights_confirmed === true ? true : (row.rights_confirmed as never),
    reuseConsent: row.reuse_consent === true ? true : (row.reuse_consent as never),
    occurredAt: new Date(String(row.occurred_at)),
    createdAt: new Date(String(row.created_at)),
  };
}

function mapPostgresError(error: unknown): Error {
  if (error instanceof LibraryRepositoryConflictError) return error;
  const code = isPostgresError(error) ? error.code : null;
  const message = error instanceof Error ? error.message : '';
  if (message.includes('LIBRARY_PROVENANCE_IMMUTABLE')) {
    return new LibraryRepositoryConflictError(
      'LIBRARY_PROVENANCE_IMMUTABLE',
      'Provenance cannot be changed in the current review state',
    );
  }
  if (message.includes('LIBRARY_PROVENANCE_RESOURCE_MOVE')) {
    return new LibraryRepositoryConflictError(
      'LIBRARY_PROVENANCE_RESOURCE_MOVE',
      'Provenance cannot move between resources',
    );
  }
  const constraint = isPostgresError(error) && 'constraint' in error
    ? String((error as { constraint?: unknown }).constraint ?? '')
    : '';
  if (code === '23505' && constraint === 'library_contribution_event_review_audit_unique') {
    return new LibraryRepositoryConflictError(
      'LIBRARY_CONTRIBUTION_DUPLICATE',
      'A contribution event already exists for this review submission',
    );
  }
  if (code === '23505') {
    return new LibraryRepositoryConflictError(
      'LIBRARY_PROVENANCE_DUPLICATE',
      'Library data conflicts with an existing unique record',
    );
  }
  if (code === '23503') {
    return new LibraryRepositoryConflictError(
      'LIBRARY_REFERENCE_INVALID',
      'A library reference is invalid',
    );
  }
  if (code === '23514') {
    return new LibraryRepositoryConflictError(
      'LIBRARY_CONSTRAINT_INVALID',
      'Library data violates a database constraint',
    );
  }
  return error instanceof Error ? error : new Error('Library persistence failed');
}

function isPostgresError(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string';
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => '\\' + character);
}
