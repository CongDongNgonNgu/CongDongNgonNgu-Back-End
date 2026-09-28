import { Pool } from 'pg';
import type { PoolClient } from 'pg';

import {
  preflightError,
  TatoebaPreflightError,
  isUuid,
  validateImportActor,
  validateImportLicense,
} from './tatoeba-preflight.contract';
import {
  TATOEBA_REQUIRED_LICENSE_KEYS,
  TATOEBA_PREFLIGHT_CONNECTION_TIMEOUT_MS,
  type TatoebaImportActorRecord,
  type TatoebaImportLicenseRecord,
} from './tatoeba-preflight.types';
import { TATOEBA_IMPORT_TEST_ENVIRONMENT } from './tatoeba-preflight.types';
import {
  safeTatoebaSentenceSourceIdentity,
  validateTatoebaSentenceImportCandidate,
} from './tatoeba-sentence-import.contract';
import {
  TATOEBA_SENTENCE_IMPORT_STATEMENT_TIMEOUT_MS,
  type TatoebaSentenceImportCommand,
  type TatoebaSentenceImportOutcome,
  type TatoebaSentenceImportQuarantineReason,
  type TatoebaSentenceImportRepository,
  type TatoebaSentenceImportRepositoryHandle,
  type TatoebaSentenceImportTarget,
} from './tatoeba-sentence-import.types';

export const TATOEBA_SENTENCE_IMPORT_SQL = {
  begin: 'BEGIN',
  statementTimeout: `SET LOCAL statement_timeout = ${TATOEBA_SENTENCE_IMPORT_STATEMENT_TIMEOUT_MS}`,
  lockTimeout: `SET LOCAL lock_timeout = ${TATOEBA_SENTENCE_IMPORT_STATEMENT_TIMEOUT_MS}`,
  target: `SELECT current_database() AS database_name,
      current_user AS database_user,
      version() AS server_version`,
  advisoryLock: `SELECT pg_advisory_xact_lock(
      hashtextextended($1::text, 0)
    )`,
  globalIdentityLookup: `SELECT provenance.resource_id
    FROM library_resource_provenance AS provenance
    WHERE provenance.source_type = 'OPEN_DATASET'::library_source_type
      AND provenance.source_id = $1
    ORDER BY provenance.resource_id`,
  resourceLock: `SELECT id
    FROM library_resources
    WHERE id = $1::uuid
    FOR UPDATE`,
  resourceState: `SELECT resource.id AS resource_id,
      resource.resource_type::text AS resource_type,
      resource.review_state::text AS review_state,
      resource.provenance_revision,
      primary_language.code AS project_language,
      sentence.text_content,
      provenance.source_id,
      provenance.source_url,
      provenance.license_key,
      provenance.attribution,
      provenance.original_author_reference,
      provenance.import_batch,
      provenance.transformation_history
    FROM library_resources AS resource
    INNER JOIN library_resource_provenance AS provenance
      ON provenance.resource_id = resource.id
     AND provenance.source_type = 'OPEN_DATASET'::library_source_type
    LEFT JOIN languages AS primary_language ON primary_language.id = resource.primary_language_id
    LEFT JOIN library_sentences AS sentence ON sentence.resource_id = resource.id
    WHERE resource.id = $1::uuid
    FOR UPDATE OF resource`,
  actorUser: `SELECT id AS user_id,
      status::text AS status
    FROM users
    WHERE id = $1::uuid
    FOR SHARE`,
  actorRoles: `SELECT role_key::text AS role_key
    FROM user_roles
    WHERE user_id = $1::uuid
    ORDER BY role_key::text
    FOR SHARE`,
  license: `SELECT license_key,
      display_name,
      canonical_url,
      attribution_required,
      redistribution_allowed,
      derivative_constraints,
      active
    FROM library_licenses
    WHERE license_key = $1
    FOR SHARE`,
  insertResource: `INSERT INTO library_resources (
      resource_type,
      primary_language_id,
      secondary_language_id,
      cefr_level,
      created_by_user_id,
      visibility,
      moderation_state,
      review_state
    )
    SELECT 'SENTENCE'::library_resource_type,
      language.id,
      NULL,
      NULL,
      $1::uuid,
      'PUBLIC'::community_post_visibility,
      'ACTIVE'::community_moderation_state,
      'DRAFT'::library_review_state
    FROM languages AS language
    WHERE language.code = $2
      AND language.active = true
    RETURNING id`,
  insertSentence: `INSERT INTO library_sentences (
      resource_id,
      text_content,
      context
    ) VALUES ($1::uuid, $2, NULL)
    RETURNING resource_id`,
  insertProvenance: `INSERT INTO library_resource_provenance (
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
      source_acceptance_id
    ) VALUES (
      $1::uuid,
      'OPEN_DATASET'::library_source_type,
      $2,
      $3,
      $4,
      $5,
      $6,
      NULL,
      $7,
      $8::jsonb,
      NULL,
      NULL,
      NULL,
      NULL
    )
    RETURNING id`,
  updateResourceLanguage: `UPDATE library_resources AS resource
    SET primary_language_id = language.id
    FROM languages AS language
    WHERE resource.id = $1::uuid
      AND language.code = $2
      AND language.active = true
      AND resource.review_state IN ('DRAFT'::library_review_state, 'COMMUNITY_REVIEW'::library_review_state)
    RETURNING resource.id`,
  updateSentence: `UPDATE library_sentences
    SET text_content = $2
    WHERE resource_id = $1::uuid
    RETURNING resource_id`,
  updateProvenance: `UPDATE library_resource_provenance
    SET source_url = $2,
      license_key = $3,
      attribution = $4,
      original_author_reference = $5,
      import_batch = $6,
      transformation_history = $7::jsonb
    WHERE resource_id = $1::uuid
      AND source_type = 'OPEN_DATASET'::library_source_type
      AND source_id = $8
    RETURNING id`,
  insertSubmitAudit: `INSERT INTO library_resource_review_audits (
      resource_id,
      actor_user_id,
      previous_state,
      new_state,
      action,
      note
    ) VALUES (
      $1::uuid,
      $2::uuid,
      'DRAFT'::library_review_state,
      'COMMUNITY_REVIEW'::library_review_state,
      'SUBMIT'::library_review_action,
      NULL
    )
    RETURNING id`,
  transitionDraft: `UPDATE library_resources
    SET review_state = 'COMMUNITY_REVIEW'::library_review_state,
      reviewed_by_user_id = NULL,
      reviewed_at = NULL,
      updated_at = now()
    WHERE id = $1::uuid
      AND review_state = 'DRAFT'::library_review_state
      AND provenance_revision = $2::bigint
    RETURNING id`,
  insertInvalidateAudit: `INSERT INTO library_resource_review_audits (
      resource_id,
      actor_user_id,
      previous_state,
      new_state,
      action,
      note
    ) VALUES (
      $1::uuid,
      $2::uuid,
      'VERIFIED'::library_review_state,
      'COMMUNITY_REVIEW'::library_review_state,
      'INVALIDATE'::library_review_action,
      NULL
    )
    RETURNING id`,
  transitionVerified: `UPDATE library_resources
    SET review_state = 'COMMUNITY_REVIEW'::library_review_state,
      reviewed_by_user_id = NULL,
      reviewed_at = NULL,
      updated_at = now()
    WHERE id = $1::uuid
      AND review_state = 'VERIFIED'::library_review_state
    RETURNING id`,
  hydrate: `SELECT resource.id AS resource_id,
      resource.resource_type::text AS resource_type,
      resource.review_state::text AS review_state,
      primary_language.code AS project_language,
      sentence.text_content,
      provenance.source_id
    FROM library_resources AS resource
    INNER JOIN library_resource_provenance AS provenance
      ON provenance.resource_id = resource.id
     AND provenance.source_type = 'OPEN_DATASET'::library_source_type
    INNER JOIN languages AS primary_language ON primary_language.id = resource.primary_language_id
    INNER JOIN library_sentences AS sentence ON sentence.resource_id = resource.id
    WHERE resource.id = $1::uuid`,
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
} as const;

interface QueryablePool {
  connect(): Promise<PoolClient>;
}

interface QueryResultLike {
  rows: Array<Record<string, unknown>>;
}

interface ExistingSentenceState {
  resourceId: string;
  resourceType: string;
  reviewState: string;
  provenanceRevision: number;
  projectLanguage: string;
  text: string;
  sourceIdentity: string;
  sourceUrl: string | null;
  licenseKey: string;
  attribution: string;
  owner: string | null;
  importBatch: string | null;
  snapshotId: string | null;
}

class TatoebaSentenceImportQuarantine extends Error {
  constructor(
    readonly sourceIdentity: string,
    readonly reason: TatoebaSentenceImportQuarantineReason,
  ) {
    super(reason);
    this.name = 'TatoebaSentenceImportQuarantine';
  }
}

function rows(result: QueryResultLike): Array<Record<string, unknown>> {
  return Array.isArray(result.rows) ? result.rows : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function nullableStringValue(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function readLicense(row: Record<string, unknown>): TatoebaImportLicenseRecord {
  return {
    licenseKey: stringValue(row.license_key),
    displayName: stringValue(row.display_name),
    canonicalUrl: stringValue(row.canonical_url),
    attributionRequired: row.attribution_required === true,
    redistributionAllowed: row.redistribution_allowed === null || row.redistribution_allowed === undefined
      ? null
      : row.redistribution_allowed === true,
    active: row.active === true,
    derivativeConstraints: nullableStringValue(row.derivative_constraints),
  };
}
function readExistingState(row: Record<string, unknown>): ExistingSentenceState {
  const history = Array.isArray(row.transformation_history) ? row.transformation_history : [];
  const lastTransformation = history.at(-1);
  const metadata = lastTransformation && typeof lastTransformation === 'object' && 'metadata' in lastTransformation
    && lastTransformation.metadata && typeof lastTransformation.metadata === 'object'
    ? lastTransformation.metadata as Record<string, unknown>
    : null;
  return {
    resourceId: stringValue(row.resource_id),
    resourceType: stringValue(row.resource_type),
    reviewState: stringValue(row.review_state),
    provenanceRevision: Number(row.provenance_revision ?? 0),
    projectLanguage: stringValue(row.project_language),
    text: stringValue(row.text_content),
    sourceIdentity: stringValue(row.source_id),
    sourceUrl: nullableStringValue(row.source_url),
    licenseKey: stringValue(row.license_key),
    attribution: stringValue(row.attribution),
    owner: nullableStringValue(row.original_author_reference),
    importBatch: nullableStringValue(row.import_batch),
    snapshotId: nullableStringValue(metadata?.snapshotId),
  };
}

function transformationHistory(candidate: TatoebaSentenceImportCommand['candidate']): string {
  return JSON.stringify([{
    operation: 'TATOEBA_SENTENCE_IMPORT',
    metadata: {
      provider: 'TATOEBA',
      endpointSentenceId: candidate.sentenceId,
      snapshotId: candidate.snapshotId,
      apiCheckedAt: candidate.apiCheckedAt,
    },
    occurredAt: candidate.apiCheckedAt,
  }]);
}

function candidateFactsMatch(
  existing: ExistingSentenceState,
  command: TatoebaSentenceImportCommand,
  licenseKey: string,
): boolean {
  const { candidate } = command;
  return existing.sourceIdentity === candidate.sourceIdentity
    && existing.projectLanguage === candidate.projectLanguage
    && existing.text === candidate.text
    && existing.licenseKey === licenseKey
    && existing.sourceUrl === candidate.sourceUrl
    && existing.attribution === candidate.attribution
    && existing.owner === candidate.owner
    && existing.importBatch === candidate.importBatch
    && existing.snapshotId === candidate.snapshotId;
}

async function queryRows(
  client: PoolClient,
  sql: string,
  values: readonly unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  const result = await client.query(sql, values as unknown[]);
  return rows(result as QueryResultLike);
}

export class PostgresTatoebaSentenceImportRepository implements TatoebaSentenceImportRepository {
  constructor(
    private readonly pool: QueryablePool,
    private readonly expectedDatabaseName: string,
    private readonly expectedDatabaseUser: string,
  ) {}

  async importSentence(command: TatoebaSentenceImportCommand): Promise<TatoebaSentenceImportOutcome> {
    if (!isUuid(command.actorUserId)) {
      return {
        status: 'QUARANTINED',
        sourceIdentity: safeTatoebaSentenceSourceIdentity(command.candidate.sourceIdentity),
        reason: 'TATOEBA_IMPORT_ACTOR_ID_INVALID',
        durableResourceCreated: false,
      };
    }
    const validation = validateTatoebaSentenceImportCandidate(command.candidate);
    if (!validation.ok) {
      return {
        status: 'QUARANTINED',
        sourceIdentity: safeTatoebaSentenceSourceIdentity(command.candidate.sourceIdentity),
        reason: validation.reason,
        durableResourceCreated: false,
      };
    }

    let client: PoolClient | null = null;
    let transactionStarted = false;
    try {
      client = await this.pool.connect();
      await client.query(TATOEBA_SENTENCE_IMPORT_SQL.begin);
      transactionStarted = true;
      await client.query(TATOEBA_SENTENCE_IMPORT_SQL.statementTimeout);
      await client.query(TATOEBA_SENTENCE_IMPORT_SQL.lockTimeout);

      const targetRows = await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.target);
      const target = targetRows[0];
      if (stringValue(target?.database_name) !== this.expectedDatabaseName) {
        throw preflightError(
          'TATOEBA_IMPORT_DATABASE_NAME_MISMATCH',
          'The connected database name is not the explicitly expected TEST database.',
        );
      }
      if (stringValue(target?.database_user) !== this.expectedDatabaseUser) {
        throw preflightError(
          'TATOEBA_IMPORT_DATABASE_USER_MISMATCH',
          'The connected database user is not the explicitly expected TEST user.',
        );
      }

      await client.query(TATOEBA_SENTENCE_IMPORT_SQL.advisoryLock, [validation.lockIdentity]);
      const identityRows = await queryRows(
        client,
        TATOEBA_SENTENCE_IMPORT_SQL.globalIdentityLookup,
        [validation.sourceIdentity],
      );
      if (identityRows.length > 1) {
        throw new TatoebaSentenceImportQuarantine(
          validation.sourceIdentity,
          'TATOEBA_IMPORT_INTEGRITY_CONFLICT',
        );
      }

      await this.validateActorAndLicenses(client, command.actorUserId, validation.sourceIdentity);

      let outcome: TatoebaSentenceImportOutcome;
      if (identityRows.length === 0) {
        outcome = await this.createNewSentence(client, command, validation.libraryLicenseKey);
      } else {
        const resourceId = stringValue(identityRows[0]?.resource_id);
        const lockedResourceRows = await queryRows(
          client,
          TATOEBA_SENTENCE_IMPORT_SQL.resourceLock,
          [resourceId],
        );
        if (lockedResourceRows.length !== 1) {
          throw new TatoebaSentenceImportQuarantine(
            validation.sourceIdentity,
            'TATOEBA_IMPORT_INTEGRITY_CONFLICT',
          );
        }

        const stateRows = await queryRows(
          client,
          TATOEBA_SENTENCE_IMPORT_SQL.resourceState,
          [resourceId],
        );
        if (stateRows.length !== 1) {
          throw new TatoebaSentenceImportQuarantine(
            validation.sourceIdentity,
            'TATOEBA_IMPORT_INTEGRITY_CONFLICT',
          );
        }
        outcome = await this.reconcileExistingSentence(
          client,
          readExistingState(stateRows[0]),
          command,
          validation.libraryLicenseKey,
        );
      }

      if (outcome.status === 'QUARANTINED') {
        throw new TatoebaSentenceImportQuarantine(
          validation.sourceIdentity,
          outcome.reason,
        );
      }
      const hydratedRows = await queryRows(
        client,
        TATOEBA_SENTENCE_IMPORT_SQL.hydrate,
        [outcome.resourceId],
      );
      const hydrated = hydratedRows[0];
      const hydratedMatches = hydrated
        && stringValue(hydrated.resource_id) === outcome.resourceId
        && stringValue(hydrated.resource_type) === 'SENTENCE'
        && stringValue(hydrated.review_state) === outcome.reviewState
        && stringValue(hydrated.source_id) === validation.sourceIdentity
        && (outcome.status === 'INVALIDATED' || stringValue(hydrated.text_content) === command.candidate.text)
        && (outcome.status === 'INVALIDATED' || stringValue(hydrated.project_language) === command.candidate.projectLanguage);
      if (hydratedRows.length !== 1 || !hydratedMatches) {
        throw new TatoebaSentenceImportQuarantine(
          validation.sourceIdentity,
          'TATOEBA_IMPORT_INTEGRITY_CONFLICT',
        );
      }

      await client.query(TATOEBA_SENTENCE_IMPORT_SQL.commit);
      transactionStarted = false;
      return outcome;
    } catch (error) {
      if (client && transactionStarted) {
        await client.query(TATOEBA_SENTENCE_IMPORT_SQL.rollback).catch(() => undefined);
      }
      if (error instanceof TatoebaSentenceImportQuarantine) {
        return {
          status: 'QUARANTINED',
          sourceIdentity: error.sourceIdentity,
          reason: error.reason,
          durableResourceCreated: false,
        };
      }
      if (error instanceof TatoebaPreflightError) throw error;
      throw preflightError(
        'TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE',
        'Tatoeba sentence import database access failed closed.',
      );
    } finally {
      try {
        client?.release();
      } catch {
        // Client release has no safe diagnostic value.
      }
    }
  }

  private async validateActorAndLicenses(
    client: PoolClient,
    actorUserId: string,
    sourceIdentity: string,
  ): Promise<void> {
    const actorRows = await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.actorUser, [actorUserId]);
    const actorRow = actorRows[0];
    if (!actorRow) {
      throw new TatoebaSentenceImportQuarantine(sourceIdentity, 'TATOEBA_IMPORT_ACTOR_NOT_FOUND');
    }
    const roleRows = await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.actorRoles, [actorUserId]);
    const actor: TatoebaImportActorRecord = {
      userId: stringValue(actorRow.user_id),
      status: stringValue(actorRow.status),
      roles: roleRows.map((row) => stringValue(row.role_key)),
    };
    const actorValidation = validateImportActor(actorUserId, actor);
    if (!actorValidation.ok) {
      throw new TatoebaSentenceImportQuarantine(sourceIdentity, actorValidation.reason);
    }

    for (const key of TATOEBA_REQUIRED_LICENSE_KEYS) {
      const licenseRows = await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.license, [key]);
      const license = licenseRows[0] ? readLicense(licenseRows[0]) : null;
      const validation = validateImportLicense(key, license);
      if (!validation.ok) {
        throw new TatoebaSentenceImportQuarantine(sourceIdentity, validation.reason);
      }
    }
  }

  private async createNewSentence(
    client: PoolClient,
    command: TatoebaSentenceImportCommand,
    licenseKey: string,
  ): Promise<TatoebaSentenceImportOutcome> {
    const { candidate } = command;
    const resourceRows = await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.insertResource, [
      command.actorUserId,
      candidate.projectLanguage,
    ]);
    const resourceId = stringValue(resourceRows[0]?.id);
    if (resourceRows.length !== 1 || !resourceId) {
      throw new TatoebaSentenceImportQuarantine(candidate.sourceIdentity, 'TATOEBA_IMPORT_INTEGRITY_CONFLICT');
    }

    const sentenceRows = await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.insertSentence, [resourceId, candidate.text]);
    const provenanceRows = await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.insertProvenance, [
      resourceId,
      candidate.sourceIdentity,
      candidate.sourceUrl,
      licenseKey,
      candidate.attribution,
      candidate.owner,
      candidate.importBatch,
      transformationHistory(candidate),
    ]);
    const auditRows = await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.insertSubmitAudit, [resourceId, command.actorUserId]);
    if (sentenceRows.length !== 1 || provenanceRows.length !== 1 || auditRows.length !== 1) {
      throw new TatoebaSentenceImportQuarantine(candidate.sourceIdentity, 'TATOEBA_IMPORT_INTEGRITY_CONFLICT');
    }
    const transitionRows = await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.transitionDraft, [resourceId, 1]);
    if (transitionRows.length !== 1) {
      throw new TatoebaSentenceImportQuarantine(candidate.sourceIdentity, 'TATOEBA_IMPORT_INTEGRITY_CONFLICT');
    }

    return {
      status: 'CREATED',
      sourceIdentity: candidate.sourceIdentity,
      resourceId,
      reviewState: 'COMMUNITY_REVIEW',
      durableResourceCreated: true,
    };
  }

  private async reconcileExistingSentence(
    client: PoolClient,
    existing: ExistingSentenceState,
    command: TatoebaSentenceImportCommand,
    licenseKey: string,
  ): Promise<TatoebaSentenceImportOutcome> {
    const { candidate } = command;
    if (existing.resourceType !== 'SENTENCE' || existing.sourceIdentity !== candidate.sourceIdentity) {
      throw new TatoebaSentenceImportQuarantine(candidate.sourceIdentity, 'TATOEBA_IMPORT_INTEGRITY_CONFLICT');
    }

    const sameFacts = candidateFactsMatch(existing, command, licenseKey);
    if (existing.reviewState === 'REJECTED' && !sameFacts) {
      throw new TatoebaSentenceImportQuarantine(candidate.sourceIdentity, 'TATOEBA_IMPORT_REJECTED_NO_REOPEN');
    }
    if (existing.reviewState === 'VERIFIED' && !sameFacts) {
      await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.insertInvalidateAudit, [
        existing.resourceId,
        command.actorUserId,
      ]);
      const invalidatedRows = await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.transitionVerified, [existing.resourceId]);
      if (invalidatedRows.length !== 1) {
        throw new TatoebaSentenceImportQuarantine(candidate.sourceIdentity, 'TATOEBA_IMPORT_INTEGRITY_CONFLICT');
      }
      return {
        status: 'INVALIDATED',
        sourceIdentity: candidate.sourceIdentity,
        resourceId: existing.resourceId,
        reviewState: 'COMMUNITY_REVIEW',
        durableResourceCreated: false,
      };
    }
    if (sameFacts && existing.reviewState !== 'DRAFT') {
      return {
        status: 'NOOP',
        sourceIdentity: candidate.sourceIdentity,
        resourceId: existing.resourceId,
        reviewState: existing.reviewState as 'COMMUNITY_REVIEW' | 'VERIFIED' | 'REJECTED',
        durableResourceCreated: false,
      };
    }

    if (!sameFacts) {
      const sentenceRows = await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.updateSentence, [
        existing.resourceId,
        candidate.text,
      ]);
      const languageRows = await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.updateResourceLanguage, [
        existing.resourceId,
        candidate.projectLanguage,
      ]);
      const provenanceRows = await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.updateProvenance, [
        existing.resourceId,
        candidate.sourceUrl,
        licenseKey,
        candidate.attribution,
        candidate.owner,
        candidate.importBatch,
        transformationHistory(candidate),
        candidate.sourceIdentity,
      ]);
      if (sentenceRows.length !== 1 || languageRows.length !== 1 || provenanceRows.length !== 1) {
        throw new TatoebaSentenceImportQuarantine(candidate.sourceIdentity, 'TATOEBA_IMPORT_INTEGRITY_CONFLICT');
      }
    }

    if (existing.reviewState === 'DRAFT') {
      await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.insertSubmitAudit, [
        existing.resourceId,
        command.actorUserId,
      ]);
      const transitionRows = await queryRows(client, TATOEBA_SENTENCE_IMPORT_SQL.transitionDraft, [
        existing.resourceId,
        existing.provenanceRevision + (sameFacts ? 0 : 1),
      ]);
      if (transitionRows.length !== 1) {
        throw new TatoebaSentenceImportQuarantine(candidate.sourceIdentity, 'TATOEBA_IMPORT_INTEGRITY_CONFLICT');
      }
    }

    return {
      status: 'RECONCILED',
      sourceIdentity: candidate.sourceIdentity,
      resourceId: existing.resourceId,
      reviewState: 'COMMUNITY_REVIEW',
      durableResourceCreated: false,
    };
  }
}

const LOCAL_DATABASE_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const REMOTE_DATABASE_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);

function validateWriterTarget(target: TatoebaSentenceImportTarget): void {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(target.databaseUrl);
  } catch {
    throw preflightError('TATOEBA_IMPORT_DATABASE_URL_INVALID', 'The dedicated TEST database URL is invalid.');
  }
  if ((parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') || !parsedUrl.hostname) {
    throw preflightError(
      'TATOEBA_IMPORT_DATABASE_URL_INVALID',
      'The dedicated TEST database URL must be a PostgreSQL URL with a hostname.',
    );
  }
  const hostname = parsedUrl.hostname.toLowerCase();
  const expectedHost = target.expectedDatabaseHost.trim().toLowerCase();
  if (
    !expectedHost
    || expectedHost.includes('*')
    || expectedHost.includes('?')
    || expectedHost.includes('/')
    || expectedHost.includes('#')
    || expectedHost.includes('@')
    || hostname !== expectedHost
  ) {
    throw preflightError(
      'TATOEBA_IMPORT_DATABASE_HOST_MISMATCH',
      'The connection URL hostname does not match the explicitly expected TEST host.',
    );
  }
  if (!target.expectedDatabaseName.trim()) {
    throw preflightError(
      'TATOEBA_IMPORT_EXPECTED_DATABASE_REQUIRED',
      'The explicitly expected TEST database name is required.',
    );
  }
  if (!target.expectedDatabaseUser.trim()) {
    throw preflightError(
      'TATOEBA_IMPORT_EXPECTED_DATABASE_USER_REQUIRED',
      'The explicitly expected TEST database user is required.',
    );
  }

  const isRemote = !LOCAL_DATABASE_HOSTNAMES.has(hostname);
  const sslMode = (parsedUrl.searchParams.get('sslmode') ?? '').toLowerCase();
  if (
    isRemote
    && (
      !REMOTE_DATABASE_SSL_MODES.has(sslMode)
      || target.ssl === undefined
      || (sslMode !== 'require' && target.ssl === true)
    )
  ) {
    throw preflightError(
      'TATOEBA_IMPORT_REMOTE_SSL_REQUIRED',
      'Remote TEST sentence import requires encrypted PostgreSQL transport.',
    );
  }
}

export function createPostgresTatoebaSentenceImportRepository(
  target: TatoebaSentenceImportTarget,
): TatoebaSentenceImportRepositoryHandle {
  if (target.environment !== TATOEBA_IMPORT_TEST_ENVIRONMENT) {
    throw preflightError(
      'TATOEBA_IMPORT_ENVIRONMENT_INVALID',
      'Only the exact TEST environment is supported for Tatoeba sentence import.',
    );
  }
  validateWriterTarget(target);

  const pool = new Pool({
    connectionString: target.databaseUrl,
    max: 1,
    connectionTimeoutMillis: TATOEBA_PREFLIGHT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: TATOEBA_PREFLIGHT_CONNECTION_TIMEOUT_MS,
    ...(target.ssl === undefined ? {} : { ssl: target.ssl }),
  });
  return {
    repository: new PostgresTatoebaSentenceImportRepository(
      pool,
      target.expectedDatabaseName,
      target.expectedDatabaseUser,
    ),
    close: () => pool.end(),
  };
}
