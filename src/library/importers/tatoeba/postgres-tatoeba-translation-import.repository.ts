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
  TATOEBA_PREFLIGHT_CONNECTION_TIMEOUT_MS,
  TATOEBA_REQUIRED_LICENSE_KEYS,
  type TatoebaImportActorRecord,
  type TatoebaImportLicenseRecord,
} from './tatoeba-preflight.types';
import { TATOEBA_IMPORT_TEST_ENVIRONMENT } from './tatoeba-preflight.types';
import { parseTatoebaPreflightDatabaseTarget } from './tatoeba-preflight.target';
import {
  safeTatoebaInputPairIdentity,
  safeTatoebaTranslationIdentity,
  validateTatoebaTranslationImportCandidate,
} from './tatoeba-translation-import.contract';
import {
  TATOEBA_TRANSLATION_IMPORT_STATEMENT_TIMEOUT_MS,
  type TatoebaTranslationImportCommand,
  type TatoebaTranslationImportOutcome,
  type TatoebaTranslationImportQuarantineReason,
  type TatoebaTranslationImportRepository,
  type TatoebaTranslationImportRepositoryHandle,
  type TatoebaTranslationImportTarget,
} from './tatoeba-translation-import.types';

export const TATOEBA_TRANSLATION_IMPORT_SQL = {
  begin: 'BEGIN',
  statementTimeout: `SET LOCAL statement_timeout = ${TATOEBA_TRANSLATION_IMPORT_STATEMENT_TIMEOUT_MS}`,
  lockTimeout: `SET LOCAL lock_timeout = ${TATOEBA_TRANSLATION_IMPORT_STATEMENT_TIMEOUT_MS}`,
  target: `SELECT current_database() AS database_name,
      current_user AS database_user,
      version() AS server_version`,
  advisoryLock: `SELECT pg_advisory_xact_lock(
      hashtextextended($1::text, 0)
    )`,
  globalIdentityLookup: `SELECT provenance.resource_id,
      provenance.source_id
    FROM library_resource_provenance AS provenance
    WHERE provenance.source_type = 'OPEN_DATASET'::library_source_type
      AND provenance.source_id IN ($1, $2)
    ORDER BY provenance.source_id, provenance.resource_id`,
  resourceLock: `SELECT id
    FROM library_resources
    WHERE id = $1::uuid
    FOR UPDATE`,
  resourceState: `SELECT resource.id AS resource_id,
      resource.resource_type::text AS resource_type,
      resource.review_state::text AS review_state,
      resource.provenance_revision,
      primary_language.code AS primary_language_code,
      secondary_language.code AS secondary_language_code,
      translation.source_text,
      translation.translated_text,
      provenance.source_id,
      provenance.source_url,
      provenance.license_key,
      provenance.attribution,
      provenance.original_author_reference,
      provenance.import_batch,
      provenance.transformation_history
    FROM library_resources AS resource
    INNER JOIN library_translations AS translation
      ON translation.resource_id = resource.id
    INNER JOIN library_resource_provenance AS provenance
      ON provenance.resource_id = resource.id
     AND provenance.source_type = 'OPEN_DATASET'::library_source_type
     AND provenance.source_id IN ($2, $3)
    LEFT JOIN languages AS primary_language ON primary_language.id = resource.primary_language_id
    LEFT JOIN languages AS secondary_language ON secondary_language.id = resource.secondary_language_id
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
    SELECT 'TRANSLATION'::library_resource_type,
      primary_language.id,
      secondary_language.id,
      NULL,
      $1::uuid,
      'PUBLIC'::community_post_visibility,
      'ACTIVE'::community_moderation_state,
      'DRAFT'::library_review_state
    FROM languages AS primary_language
    INNER JOIN languages AS secondary_language
      ON secondary_language.code = $3
     AND secondary_language.active = true
    WHERE primary_language.code = $2
      AND primary_language.active = true
      AND primary_language.id <> secondary_language.id
    RETURNING id`,
  insertTranslation: `INSERT INTO library_translations (
      resource_id,
      source_text,
      translated_text
    ) VALUES ($1::uuid, $2, $3)
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
  updateTranslation: `UPDATE library_translations
    SET source_text = $2,
      translated_text = $3
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
      primary_language.code AS primary_language_code,
      secondary_language.code AS secondary_language_code,
      translation.source_text,
      translation.translated_text,
      provenance.source_id
    FROM library_resources AS resource
    INNER JOIN library_translations AS translation
      ON translation.resource_id = resource.id
    INNER JOIN library_resource_provenance AS provenance
      ON provenance.resource_id = resource.id
     AND provenance.source_type = 'OPEN_DATASET'::library_source_type
     AND provenance.source_id IN ($2, $3)
    INNER JOIN languages AS primary_language ON primary_language.id = resource.primary_language_id
    INNER JOIN languages AS secondary_language ON secondary_language.id = resource.secondary_language_id
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

interface ExistingEndpointState {
  sourceId: string;
  sourceUrl: string | null;
  licenseKey: string;
  attribution: string;
  owner: string | null;
  importBatch: string | null;
  snapshotId: string | null;
}

interface ExistingTranslationState {
  resourceId: string;
  resourceType: string;
  reviewState: string;
  provenanceRevision: number;
  primaryLanguageCode: string;
  secondaryLanguageCode: string;
  sourceText: string;
  translatedText: string;
  source: ExistingEndpointState;
  target: ExistingEndpointState;
}

class TatoebaTranslationImportQuarantine extends Error {
  constructor(
    readonly durableIdentity: string,
    readonly inputPairIdentity: string,
    readonly reason: TatoebaTranslationImportQuarantineReason,
  ) {
    super(reason);
    this.name = 'TatoebaTranslationImportQuarantine';
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

function transformationMetadata(value: unknown): Record<string, unknown> | null {
  const history = Array.isArray(value) ? value : [];
  const last = history.at(-1);
  if (!last || typeof last !== 'object' || !('metadata' in last)) return null;
  const metadata = last.metadata;
  return metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : null;
}

function readEndpointState(row: Record<string, unknown>): ExistingEndpointState {
  return {
    sourceId: stringValue(row.source_id),
    sourceUrl: nullableStringValue(row.source_url),
    licenseKey: stringValue(row.license_key),
    attribution: stringValue(row.attribution),
    owner: nullableStringValue(row.original_author_reference),
    importBatch: nullableStringValue(row.import_batch),
    snapshotId: nullableStringValue(transformationMetadata(row.transformation_history)?.snapshotId),
  };
}

function readExistingState(
  stateRows: Array<Record<string, unknown>>,
  sourceProvenanceId: string,
  targetProvenanceId: string,
): ExistingTranslationState | null {
  if (stateRows.length !== 2) return null;
  const sourceRow = stateRows.find((row) => stringValue(row.source_id) === sourceProvenanceId);
  const targetRow = stateRows.find((row) => stringValue(row.source_id) === targetProvenanceId);
  if (!sourceRow || !targetRow) return null;
  const resourceId = stringValue(sourceRow.resource_id);
  if (!resourceId || stringValue(targetRow.resource_id) !== resourceId) return null;
  const shared = [
    'resource_type',
    'review_state',
    'provenance_revision',
    'primary_language_code',
    'secondary_language_code',
    'source_text',
    'translated_text',
  ];
  if (shared.some((key) => stringValue(sourceRow[key]) !== stringValue(targetRow[key]))) return null;
  return {
    resourceId,
    resourceType: stringValue(sourceRow.resource_type),
    reviewState: stringValue(sourceRow.review_state),
    provenanceRevision: Number(sourceRow.provenance_revision ?? 0),
    primaryLanguageCode: stringValue(sourceRow.primary_language_code),
    secondaryLanguageCode: stringValue(sourceRow.secondary_language_code),
    sourceText: stringValue(sourceRow.source_text),
    translatedText: stringValue(sourceRow.translated_text),
    source: readEndpointState(sourceRow),
    target: readEndpointState(targetRow),
  };
}

function transformationHistory(
  command: TatoebaTranslationImportCommand,
  endpointRole: 'SOURCE' | 'TARGET',
  apiCheckedAt: string,
  snapshotId: string,
): string {
  const { candidate } = command;
  return JSON.stringify([{
    operation: 'TATOEBA_DIRECT_TRANSLATION_IMPORT',
    metadata: {
      provider: 'TATOEBA',
      durableIdentity: candidate.durableIdentity,
      inputPairIdentity: candidate.inputPairIdentity,
      sourceSentenceId: candidate.sourceSentenceId,
      targetSentenceId: candidate.targetSentenceId,
      endpointRole,
      primaryLanguageCode: candidate.primaryLanguageCode,
      secondaryLanguageCode: candidate.secondaryLanguageCode,
      snapshotId,
      apiCheckedAt,
    },
    occurredAt: apiCheckedAt,
  }]);
}

function endpointFactsMatch(
  existing: ExistingEndpointState,
  candidate: TatoebaTranslationImportCommand['candidate']['sourceProvenance'],
  licenseKey: string,
): boolean {
  return existing.sourceId === candidate.sourceId
    && existing.sourceUrl === candidate.sourceUrl
    && existing.licenseKey === licenseKey
    && existing.attribution === candidate.attribution
    && existing.owner === candidate.owner
    && existing.importBatch === candidate.importBatch
    && existing.snapshotId === candidate.snapshotId;
}

function candidateFactsMatch(
  existing: ExistingTranslationState,
  command: TatoebaTranslationImportCommand,
  sourceLicenseKey: string,
  targetLicenseKey: string,
): boolean {
  const { candidate } = command;
  return existing.resourceType === 'TRANSLATION'
    && existing.primaryLanguageCode === candidate.primaryLanguageCode
    && existing.secondaryLanguageCode === candidate.secondaryLanguageCode
    && existing.sourceText === candidate.sourceText
    && existing.translatedText === candidate.translatedText
    && endpointFactsMatch(existing.source, candidate.sourceProvenance, sourceLicenseKey)
    && endpointFactsMatch(existing.target, candidate.targetProvenance, targetLicenseKey);
}

async function queryRows(
  client: PoolClient,
  sql: string,
  values: readonly unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  const result = await client.query(sql, values as unknown[]);
  return rows(result as QueryResultLike);
}

export class PostgresTatoebaTranslationImportRepository implements TatoebaTranslationImportRepository {
  constructor(
    private readonly pool: QueryablePool,
    private readonly expectedDatabaseName: string,
    private readonly expectedDatabaseUser: string,
  ) {}

  async importTranslation(command: TatoebaTranslationImportCommand): Promise<TatoebaTranslationImportOutcome> {
    if (!isUuid(command.actorUserId)) {
      return {
        status: 'QUARANTINED',
        durableIdentity: null,
        inputPairIdentity: null,
        reason: 'TATOEBA_IMPORT_ACTOR_ID_INVALID',
        durableResourceCreated: false,
      };
    }
    const validation = validateTatoebaTranslationImportCandidate(command.candidate);
    if (!validation.ok) {
      return {
        status: 'QUARANTINED',
        durableIdentity: safeTatoebaTranslationIdentity(command.candidate?.durableIdentity),
        inputPairIdentity: safeTatoebaInputPairIdentity(command.candidate?.inputPairIdentity),
        reason: validation.reason,
        durableResourceCreated: false,
      };
    }

    let client: PoolClient | null = null;
    let transactionStarted = false;
    try {
      client = await this.pool.connect();
      await client.query(TATOEBA_TRANSLATION_IMPORT_SQL.begin);
      transactionStarted = true;
      await client.query(TATOEBA_TRANSLATION_IMPORT_SQL.statementTimeout);
      await client.query(TATOEBA_TRANSLATION_IMPORT_SQL.lockTimeout);

      const targetRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.target);
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

      await client.query(TATOEBA_TRANSLATION_IMPORT_SQL.advisoryLock, [validation.lockIdentity]);
      const identityRows = await queryRows(
        client,
        TATOEBA_TRANSLATION_IMPORT_SQL.globalIdentityLookup,
        [`${validation.durableIdentity}:SOURCE`, `${validation.durableIdentity}:TARGET`],
      );
      const identityResourceIds = new Set(identityRows.map((row) => stringValue(row.resource_id)).filter(Boolean));
      const sourceProvenanceId = `${validation.durableIdentity}:SOURCE`;
      const targetProvenanceId = `${validation.durableIdentity}:TARGET`;
      const sourceIdentityRow = identityRows.find((row) => stringValue(row.source_id) === sourceProvenanceId);
      const targetIdentityRow = identityRows.find((row) => stringValue(row.source_id) === targetProvenanceId);
      if (identityRows.length !== 0 && (
        identityRows.length !== 2
        || !sourceIdentityRow
        || !targetIdentityRow
        || identityResourceIds.size !== 1
      )) {
        throw new TatoebaTranslationImportQuarantine(
          validation.durableIdentity,
          validation.inputPairIdentity,
          'TATOEBA_TRANSLATION_INTEGRITY_CONFLICT',
        );
      }

      await this.validateActorAndLicenses(
        client,
        command.actorUserId,
        validation.durableIdentity,
        validation.inputPairIdentity,
        validation.sourceLicenseKey,
        validation.targetLicenseKey,
      );

      let outcome: TatoebaTranslationImportOutcome;
      if (identityRows.length === 0) {
        outcome = await this.createNewTranslation(client, command, validation.sourceLicenseKey, validation.targetLicenseKey);
      } else {
        const resourceId = stringValue(sourceIdentityRow?.resource_id);
        const lockedResourceRows = await queryRows(
          client,
          TATOEBA_TRANSLATION_IMPORT_SQL.resourceLock,
          [resourceId],
        );
        if (lockedResourceRows.length !== 1) {
          throw new TatoebaTranslationImportQuarantine(
            validation.durableIdentity,
            validation.inputPairIdentity,
            'TATOEBA_TRANSLATION_INTEGRITY_CONFLICT',
          );
        }
        const stateRows = await queryRows(
          client,
          TATOEBA_TRANSLATION_IMPORT_SQL.resourceState,
          [resourceId, sourceProvenanceId, targetProvenanceId],
        );
        const existing = readExistingState(stateRows, sourceProvenanceId, targetProvenanceId);
        if (!existing) {
          throw new TatoebaTranslationImportQuarantine(
            validation.durableIdentity,
            validation.inputPairIdentity,
            'TATOEBA_TRANSLATION_INTEGRITY_CONFLICT',
          );
        }
        outcome = await this.reconcileExistingTranslation(
          client,
          existing,
          command,
          validation.sourceLicenseKey,
          validation.targetLicenseKey,
        );
      }

      if (outcome.status === 'QUARANTINED') {
        throw new TatoebaTranslationImportQuarantine(
          validation.durableIdentity,
          validation.inputPairIdentity,
          outcome.reason,
        );
      }
      const hydratedRows = await queryRows(
        client,
        TATOEBA_TRANSLATION_IMPORT_SQL.hydrate,
        [outcome.resourceId, sourceProvenanceId, targetProvenanceId],
      );
      const hydratedIds = new Set(hydratedRows.map((row) => stringValue(row.source_id)));
      const hydrated = hydratedRows[0];
      const hydratedMatches = hydrated
        && hydratedRows.length === 2
        && hydratedIds.has(sourceProvenanceId)
        && hydratedIds.has(targetProvenanceId)
        && stringValue(hydrated.resource_id) === outcome.resourceId
        && hydratedRows.every((row) => stringValue(row.resource_id) === outcome.resourceId)
        && hydratedRows.every((row) => stringValue(row.resource_type) === 'TRANSLATION')
        && hydratedRows.every((row) => stringValue(row.review_state) === outcome.reviewState)
        && hydratedRows.every((row) => stringValue(row.primary_language_code) === command.candidate.primaryLanguageCode)
        && hydratedRows.every((row) => stringValue(row.secondary_language_code) === command.candidate.secondaryLanguageCode)
        && (outcome.status === 'INVALIDATED'
          || (stringValue(hydrated.source_text) === command.candidate.sourceText
            && stringValue(hydrated.translated_text) === command.candidate.translatedText));
      if (!hydratedMatches) {
        throw new TatoebaTranslationImportQuarantine(
          validation.durableIdentity,
          validation.inputPairIdentity,
          'TATOEBA_TRANSLATION_INTEGRITY_CONFLICT',
        );
      }

      await client.query(TATOEBA_TRANSLATION_IMPORT_SQL.commit);
      transactionStarted = false;
      return outcome;
    } catch (error) {
      if (client && transactionStarted) {
        await client.query(TATOEBA_TRANSLATION_IMPORT_SQL.rollback).catch(() => undefined);
      }
      if (error instanceof TatoebaTranslationImportQuarantine) {
        return {
          status: 'QUARANTINED',
          durableIdentity: error.durableIdentity,
          inputPairIdentity: error.inputPairIdentity,
          reason: error.reason,
          durableResourceCreated: false,
        };
      }
      if (error instanceof TatoebaPreflightError) throw error;
      throw preflightError(
        'TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE',
        'Tatoeba direct translation import database access failed closed.',
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
    durableIdentity: string,
    inputPairIdentity: string,
    sourceLicenseKey: string,
    targetLicenseKey: string,
  ): Promise<void> {
    const actorRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.actorUser, [actorUserId]);
    const actorRow = actorRows[0];
    if (!actorRow) {
      throw new TatoebaTranslationImportQuarantine(durableIdentity, inputPairIdentity, 'TATOEBA_IMPORT_ACTOR_NOT_FOUND');
    }
    const roleRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.actorRoles, [actorUserId]);
    const actor: TatoebaImportActorRecord = {
      userId: stringValue(actorRow.user_id),
      status: stringValue(actorRow.status),
      roles: roleRows.map((row) => stringValue(row.role_key)),
    };
    const actorValidation = validateImportActor(actorUserId, actor);
    if (!actorValidation.ok) {
      throw new TatoebaTranslationImportQuarantine(durableIdentity, inputPairIdentity, actorValidation.reason);
    }

    const licenseKeys = new Set([sourceLicenseKey, targetLicenseKey, ...TATOEBA_REQUIRED_LICENSE_KEYS]);
    for (const key of licenseKeys) {
      const licenseRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.license, [key]);
      const license = licenseRows[0] ? readLicense(licenseRows[0]) : null;
      const validation = validateImportLicense(key as typeof TATOEBA_REQUIRED_LICENSE_KEYS[number], license);
      if (!validation.ok) {
        throw new TatoebaTranslationImportQuarantine(durableIdentity, inputPairIdentity, validation.reason);
      }
    }
  }

  private async createNewTranslation(
    client: PoolClient,
    command: TatoebaTranslationImportCommand,
    sourceLicenseKey: string,
    targetLicenseKey: string,
  ): Promise<TatoebaTranslationImportOutcome> {
    const { candidate } = command;
    const resourceRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.insertResource, [
      command.actorUserId,
      candidate.primaryLanguageCode,
      candidate.secondaryLanguageCode,
    ]);
    const resourceId = stringValue(resourceRows[0]?.id);
    if (resourceRows.length !== 1 || !resourceId) {
      throw new TatoebaTranslationImportQuarantine(candidate.durableIdentity, candidate.inputPairIdentity, 'TATOEBA_TRANSLATION_INTEGRITY_CONFLICT');
    }

    const translationRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.insertTranslation, [
      resourceId,
      candidate.sourceText,
      candidate.translatedText,
    ]);
    const sourceProvenanceRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.insertProvenance, [
      resourceId,
      candidate.sourceProvenance.sourceId,
      candidate.sourceProvenance.sourceUrl,
      sourceLicenseKey,
      candidate.sourceProvenance.attribution,
      candidate.sourceProvenance.owner,
      candidate.sourceProvenance.importBatch,
      transformationHistory(
        command,
        'SOURCE',
        candidate.sourceProvenance.apiCheckedAt,
        candidate.sourceProvenance.snapshotId,
      ),
    ]);
    const targetProvenanceRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.insertProvenance, [
      resourceId,
      candidate.targetProvenance.sourceId,
      candidate.targetProvenance.sourceUrl,
      targetLicenseKey,
      candidate.targetProvenance.attribution,
      candidate.targetProvenance.owner,
      candidate.targetProvenance.importBatch,
      transformationHistory(
        command,
        'TARGET',
        candidate.targetProvenance.apiCheckedAt,
        candidate.targetProvenance.snapshotId,
      ),
    ]);
    const auditRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.insertSubmitAudit, [resourceId, command.actorUserId]);
    if (translationRows.length !== 1 || sourceProvenanceRows.length !== 1 || targetProvenanceRows.length !== 1 || auditRows.length !== 1) {
      throw new TatoebaTranslationImportQuarantine(candidate.durableIdentity, candidate.inputPairIdentity, 'TATOEBA_TRANSLATION_INTEGRITY_CONFLICT');
    }
    const transitionRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.transitionDraft, [resourceId, 2]);
    if (transitionRows.length !== 1) {
      throw new TatoebaTranslationImportQuarantine(candidate.durableIdentity, candidate.inputPairIdentity, 'TATOEBA_TRANSLATION_INTEGRITY_CONFLICT');
    }

    return {
      status: 'CREATED',
      durableIdentity: candidate.durableIdentity,
      inputPairIdentity: candidate.inputPairIdentity,
      resourceId,
      reviewState: 'COMMUNITY_REVIEW',
      durableResourceCreated: true,
    };
  }

  private async reconcileExistingTranslation(
    client: PoolClient,
    existing: ExistingTranslationState,
    command: TatoebaTranslationImportCommand,
    sourceLicenseKey: string,
    targetLicenseKey: string,
  ): Promise<TatoebaTranslationImportOutcome> {
    const { candidate } = command;
    if (
      existing.resourceType !== 'TRANSLATION'
      || existing.primaryLanguageCode !== candidate.primaryLanguageCode
      || existing.secondaryLanguageCode !== candidate.secondaryLanguageCode
    ) {
      throw new TatoebaTranslationImportQuarantine(candidate.durableIdentity, candidate.inputPairIdentity, 'TATOEBA_TRANSLATION_INTEGRITY_CONFLICT');
    }

    const sameFacts = candidateFactsMatch(existing, command, sourceLicenseKey, targetLicenseKey);
    if (existing.reviewState === 'REJECTED' && !sameFacts) {
      throw new TatoebaTranslationImportQuarantine(candidate.durableIdentity, candidate.inputPairIdentity, 'TATOEBA_TRANSLATION_REJECTED_NO_REOPEN');
    }
    if (existing.reviewState === 'VERIFIED' && !sameFacts) {
      const auditRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.insertInvalidateAudit, [existing.resourceId, command.actorUserId]);
      const transitionRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.transitionVerified, [existing.resourceId]);
      if (auditRows.length !== 1 || transitionRows.length !== 1) {
        throw new TatoebaTranslationImportQuarantine(candidate.durableIdentity, candidate.inputPairIdentity, 'TATOEBA_TRANSLATION_INTEGRITY_CONFLICT');
      }
      return {
        status: 'INVALIDATED',
        durableIdentity: candidate.durableIdentity,
        inputPairIdentity: candidate.inputPairIdentity,
        resourceId: existing.resourceId,
        reviewState: 'COMMUNITY_REVIEW',
        durableResourceCreated: false,
      };
    }
    if (sameFacts && existing.reviewState !== 'DRAFT') {
      return {
        status: 'NOOP',
        durableIdentity: candidate.durableIdentity,
        inputPairIdentity: candidate.inputPairIdentity,
        resourceId: existing.resourceId,
        reviewState: existing.reviewState as 'COMMUNITY_REVIEW' | 'VERIFIED' | 'REJECTED',
        durableResourceCreated: false,
      };
    }
    if (!['DRAFT', 'COMMUNITY_REVIEW', 'VERIFIED', 'REJECTED'].includes(existing.reviewState)) {
      throw new TatoebaTranslationImportQuarantine(candidate.durableIdentity, candidate.inputPairIdentity, 'TATOEBA_TRANSLATION_INTEGRITY_CONFLICT');
    }

    if (!sameFacts) {
      const translationRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.updateTranslation, [
        existing.resourceId,
        candidate.sourceText,
        candidate.translatedText,
      ]);
      const sourceProvenanceRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.updateProvenance, [
        existing.resourceId,
        candidate.sourceProvenance.sourceUrl,
        sourceLicenseKey,
        candidate.sourceProvenance.attribution,
        candidate.sourceProvenance.owner,
        candidate.sourceProvenance.importBatch,
        transformationHistory(command, 'SOURCE', candidate.sourceProvenance.apiCheckedAt, candidate.sourceProvenance.snapshotId),
        candidate.sourceProvenance.sourceId,
      ]);
      const targetProvenanceRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.updateProvenance, [
        existing.resourceId,
        candidate.targetProvenance.sourceUrl,
        targetLicenseKey,
        candidate.targetProvenance.attribution,
        candidate.targetProvenance.owner,
        candidate.targetProvenance.importBatch,
        transformationHistory(command, 'TARGET', candidate.targetProvenance.apiCheckedAt, candidate.targetProvenance.snapshotId),
        candidate.targetProvenance.sourceId,
      ]);
      if (translationRows.length !== 1 || sourceProvenanceRows.length !== 1 || targetProvenanceRows.length !== 1) {
        throw new TatoebaTranslationImportQuarantine(candidate.durableIdentity, candidate.inputPairIdentity, 'TATOEBA_TRANSLATION_INTEGRITY_CONFLICT');
      }
    }

    if (existing.reviewState === 'DRAFT') {
      const auditRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.insertSubmitAudit, [existing.resourceId, command.actorUserId]);
      const transitionRows = await queryRows(client, TATOEBA_TRANSLATION_IMPORT_SQL.transitionDraft, [
        existing.resourceId,
        existing.provenanceRevision + (sameFacts ? 0 : 2),
      ]);
      if (auditRows.length !== 1 || transitionRows.length !== 1) {
        throw new TatoebaTranslationImportQuarantine(candidate.durableIdentity, candidate.inputPairIdentity, 'TATOEBA_TRANSLATION_INTEGRITY_CONFLICT');
      }
    }

    return {
      status: 'RECONCILED',
      durableIdentity: candidate.durableIdentity,
      inputPairIdentity: candidate.inputPairIdentity,
      resourceId: existing.resourceId,
      reviewState: 'COMMUNITY_REVIEW',
      durableResourceCreated: false,
    };
  }
}

export function createPostgresTatoebaTranslationImportRepository(
  target: TatoebaTranslationImportTarget,
): TatoebaTranslationImportRepositoryHandle {
  if (target.environment !== TATOEBA_IMPORT_TEST_ENVIRONMENT) {
    throw preflightError('TATOEBA_IMPORT_ENVIRONMENT_INVALID', 'Only the exact TEST environment is supported for Tatoeba translation import.');
  }
  const parsedTarget = parseTatoebaPreflightDatabaseTarget(
    target.databaseUrl,
    target.expectedDatabaseHost,
    target.expectedDatabaseName,
    target.expectedDatabaseUser,
  );
  const pool = new Pool({
    connectionString: target.databaseUrl,
    max: 1,
    connectionTimeoutMillis: TATOEBA_PREFLIGHT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: TATOEBA_PREFLIGHT_CONNECTION_TIMEOUT_MS,
    ...(parsedTarget.ssl === undefined ? {} : { ssl: parsedTarget.ssl }),
  });
  return {
    repository: new PostgresTatoebaTranslationImportRepository(
      pool,
      target.expectedDatabaseName,
      target.expectedDatabaseUser,
    ),
    close: () => pool.end(),
  };
}
