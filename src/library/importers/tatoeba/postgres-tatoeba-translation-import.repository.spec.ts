import type { PoolClient } from 'pg';
import { describe, expect, it, jest } from '@jest/globals';

import { buildTatoebaAttribution, sentenceSourceUrl } from './tatoeba.attribution';
import {
  PostgresTatoebaTranslationImportRepository,
  TATOEBA_TRANSLATION_IMPORT_SQL,
} from './postgres-tatoeba-translation-import.repository';
import { directTranslationIdentity, inputPairIdentity, translationProvenanceSourceId } from './tatoeba.identities';
import type { TatoebaTranslationImportCommand } from './tatoeba-translation-import.types';

const ACTOR_ID = '00000000-0000-4000-8000-000000000001';
const RESOURCE_ID = '00000000-0000-4000-8000-000000000010';
const SOURCE_SENTENCE_RESOURCE_ID = '00000000-0000-4000-8000-000000000011';
const TARGET_SENTENCE_RESOURCE_ID = '00000000-0000-4000-8000-000000000012';
const sourceId = '100';
const targetId = '200';
const durableIdentity = directTranslationIdentity(sourceId, targetId);
const pairIdentity = inputPairIdentity(sourceId, targetId);
const sourceProvenanceId = translationProvenanceSourceId(sourceId, targetId, 'SOURCE');
const targetProvenanceId = translationProvenanceSourceId(sourceId, targetId, 'TARGET');

const command: TatoebaTranslationImportCommand = {
  actorUserId: ACTOR_ID,
  candidate: {
    provider: 'TATOEBA',
    inputPairIdentity: pairIdentity,
    durableIdentity,
    primaryLanguageCode: 'vi',
    secondaryLanguageCode: 'en',
    sourceSentenceId: sourceId,
    targetSentenceId: targetId,
    sourceText: 'Xin chào',
    translatedText: 'Hello',
    sourceProvenance: {
      sourceId: sourceProvenanceId,
      sourceUrl: sentenceSourceUrl(sourceId),
      license: 'CC BY 2.0 FR',
      owner: 'alice',
      attribution: buildTatoebaAttribution({
        sentenceId: sourceId,
        sourceUrl: sentenceSourceUrl(sourceId),
        license: 'CC BY 2.0 FR',
        owner: 'alice',
        transformationNote: null,
      }),
      endpointSentenceId: sourceId,
      endpointRole: 'SOURCE',
      relationIdentity: durableIdentity,
      inputPairIdentity: pairIdentity,
      primaryLanguageCode: 'vi',
      secondaryLanguageCode: 'en',
      importBatch: 'tatoeba-08d3c-test',
      snapshotId: 'TATOEBA-SNAPSHOT-test',
      apiCheckedAt: '2026-09-28T00:00:01.000Z',
      transformationNote: null,
    },
    targetProvenance: {
      sourceId: targetProvenanceId,
      sourceUrl: sentenceSourceUrl(targetId),
      license: 'CC0 1.0',
      owner: null,
      attribution: buildTatoebaAttribution({
        sentenceId: targetId,
        sourceUrl: sentenceSourceUrl(targetId),
        license: 'CC0 1.0',
        owner: null,
        transformationNote: null,
      }),
      endpointSentenceId: targetId,
      endpointRole: 'TARGET',
      relationIdentity: durableIdentity,
      inputPairIdentity: pairIdentity,
      primaryLanguageCode: 'vi',
      secondaryLanguageCode: 'en',
      importBatch: 'tatoeba-08d3c-test',
      snapshotId: 'TATOEBA-SNAPSHOT-test',
      apiCheckedAt: '2026-09-28T00:00:02.000Z',
      transformationNote: null,
    },
  },
};

type QueryFn = (...args: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

function fakeClient(query: QueryFn): PoolClient {
  return { query, release: jest.fn() } as unknown as PoolClient;
}

function targetRows() {
  return [{ database_name: 'congdongngonngu_test', database_user: 'readonly_test', server_version: 'PostgreSQL 16' }];
}

function actorRows() {
  return [{ user_id: ACTOR_ID, status: 'ACTIVE' }];
}

function licenseRow(key: 'CC_BY_2_0_FR' | 'CC0_1_0') {
  return [{
    license_key: key,
    display_name: key === 'CC_BY_2_0_FR' ? 'CC BY 2.0 France' : 'CC0 1.0',
    canonical_url: key === 'CC_BY_2_0_FR'
      ? 'https://creativecommons.org/licenses/by/2.0/fr/'
      : 'https://creativecommons.org/publicdomain/zero/1.0/',
    attribution_required: key === 'CC_BY_2_0_FR',
    redistribution_allowed: true,
    active: true,
  }];
}

function canonicalSentenceRows(overrides: {
  source?: Record<string, unknown>;
  target?: Record<string, unknown>;
} = {}) {
  return [
    {
      source_id: `TATOEBA:SENTENCE:${sourceId}`,
      resource_id: SOURCE_SENTENCE_RESOURCE_ID,
      resource_type: 'SENTENCE',
      project_language: 'vi',
      text_content: command.candidate.sourceText,
      source_url: command.candidate.sourceProvenance.sourceUrl,
      license_key: 'CC_BY_2_0_FR',
      attribution: command.candidate.sourceProvenance.attribution,
      original_author_reference: command.candidate.sourceProvenance.owner,
      import_batch: command.candidate.sourceProvenance.importBatch,
      transformation_history: [{ metadata: { snapshotId: command.candidate.sourceProvenance.snapshotId } }],
      ...overrides.source,
    },
    {
      source_id: `TATOEBA:SENTENCE:${targetId}`,
      resource_id: TARGET_SENTENCE_RESOURCE_ID,
      resource_type: 'SENTENCE',
      project_language: 'en',
      text_content: command.candidate.translatedText,
      source_url: command.candidate.targetProvenance.sourceUrl,
      license_key: 'CC0_1_0',
      attribution: command.candidate.targetProvenance.attribution,
      original_author_reference: command.candidate.targetProvenance.owner,
      import_batch: command.candidate.targetProvenance.importBatch,
      transformation_history: [{ metadata: { snapshotId: command.candidate.targetProvenance.snapshotId } }],
      ...overrides.target,
    },
  ];
}

function hydratedRows(reviewState = 'COMMUNITY_REVIEW') {
  return [
    {
      resource_id: RESOURCE_ID,
      resource_type: 'TRANSLATION',
      review_state: reviewState,
      primary_language_code: 'vi',
      secondary_language_code: 'en',
      source_text: command.candidate.sourceText,
      translated_text: command.candidate.translatedText,
      source_id: sourceProvenanceId,
    },
    {
      resource_id: RESOURCE_ID,
      resource_type: 'TRANSLATION',
      review_state: reviewState,
      primary_language_code: 'vi',
      secondary_language_code: 'en',
      source_text: command.candidate.sourceText,
      translated_text: command.candidate.translatedText,
      source_id: targetProvenanceId,
    },
  ];
}

function stateRows(reviewState = 'COMMUNITY_REVIEW', sourceText = command.candidate.sourceText) {
  const common = {
    resource_id: RESOURCE_ID,
    resource_type: 'TRANSLATION',
    review_state: reviewState,
    provenance_revision: '2',
    primary_language_code: 'vi',
    secondary_language_code: 'en',
    source_text: sourceText,
    translated_text: command.candidate.translatedText,
  };
  return [
    {
      ...common,
      source_id: sourceProvenanceId,
      source_url: command.candidate.sourceProvenance.sourceUrl,
      license_key: 'CC_BY_2_0_FR',
      attribution: command.candidate.sourceProvenance.attribution,
      original_author_reference: 'alice',
      import_batch: command.candidate.sourceProvenance.importBatch,
      transformation_history: [{ metadata: { snapshotId: command.candidate.sourceProvenance.snapshotId } }],
    },
    {
      ...common,
      source_id: targetProvenanceId,
      source_url: command.candidate.targetProvenance.sourceUrl,
      license_key: 'CC0_1_0',
      attribution: command.candidate.targetProvenance.attribution,
      original_author_reference: null,
      import_batch: command.candidate.targetProvenance.importBatch,
      transformation_history: [{ metadata: { snapshotId: command.candidate.targetProvenance.snapshotId } }],
    },
  ];
}

function repositoryWith(query: QueryFn, release = jest.fn()) {
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: async () => client };
  return {
    repository: new PostgresTatoebaTranslationImportRepository(pool, 'congdongngonngu_test', 'readonly_test'),
    client,
    release,
  };
}

function createQuery(): jest.MockedFunction<QueryFn> {
  return jest.fn<QueryFn>()
    .mockResolvedValueOnce({ rows: [] }) // BEGIN
    .mockResolvedValueOnce({ rows: [] }) // statement timeout
    .mockResolvedValueOnce({ rows: [] }) // lock timeout
    .mockResolvedValueOnce({ rows: targetRows() })
    .mockResolvedValueOnce({ rows: [] }) // advisory lock
    .mockResolvedValueOnce({ rows: [] }) // directed role lookup
    .mockResolvedValueOnce({ rows: actorRows() })
    .mockResolvedValueOnce({ rows: [{ role_key: 'ADMIN' }] })
    .mockResolvedValueOnce({ rows: licenseRow('CC_BY_2_0_FR') })
    .mockResolvedValueOnce({ rows: licenseRow('CC0_1_0') })
    .mockResolvedValueOnce({ rows: canonicalSentenceRows() })
    .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
    .mockResolvedValueOnce({ rows: [{ resource_id: RESOURCE_ID }] })
    .mockResolvedValueOnce({ rows: [{ id: '00000000-0000-4000-8000-000000000020' }] })
    .mockResolvedValueOnce({ rows: [{ id: '00000000-0000-4000-8000-000000000021' }] })
    .mockResolvedValueOnce({ rows: [{ id: '00000000-0000-4000-8000-000000000030' }] })
    .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] }) // transition
    .mockResolvedValueOnce({ rows: hydratedRows() })
    .mockResolvedValueOnce({ rows: [] }); // COMMIT
}

class AsyncMutex {
  private locked = false;
  private readonly waiters: Array<(release: () => void) => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next(() => this.release());
    else this.locked = false;
  }
}

function concurrentPool() {
  const mutex = new AsyncMutex();
  const state = { committed: false, pending: false, commitCount: 0 };
  const createClient = (): PoolClient => {
    let releaseLock: (() => void) | null = null;
    const query = jest.fn<QueryFn>().mockImplementation(async (sql, values) => {
      if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.begin) return { rows: [] };
      if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.statementTimeout || sql === TATOEBA_TRANSLATION_IMPORT_SQL.lockTimeout) return { rows: [] };
      if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.target) return { rows: targetRows() };
      if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.advisoryLock) {
        releaseLock = await mutex.acquire();
        return { rows: [] };
      }
      if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.globalIdentityLookup) {
        return {
          rows: state.committed
            ? [
              { resource_id: RESOURCE_ID, source_id: sourceProvenanceId },
              { resource_id: RESOURCE_ID, source_id: targetProvenanceId },
            ]
            : [],
        };
      }
      if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.actorUser) return { rows: actorRows() };
      if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.actorRoles) return { rows: [{ role_key: 'ADMIN' }] };
      if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.license) {
        const key = String(Array.isArray(values) ? values[0] : '');
        return { rows: licenseRow(key === 'CC0_1_0' ? 'CC0_1_0' : 'CC_BY_2_0_FR') };
      }
      if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.canonicalSentenceEndpointLookup) {
        return { rows: canonicalSentenceRows() };
      }
      if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.resourceLock) return { rows: [{ id: RESOURCE_ID }] };
      if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.resourceState) return { rows: stateRows() };
      if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.insertResource) {
        state.pending = true;
        return { rows: [{ id: RESOURCE_ID }] };
      }
      if (
        sql === TATOEBA_TRANSLATION_IMPORT_SQL.insertTranslation
        || sql === TATOEBA_TRANSLATION_IMPORT_SQL.insertProvenance
        || sql === TATOEBA_TRANSLATION_IMPORT_SQL.insertSubmitAudit
        || sql === TATOEBA_TRANSLATION_IMPORT_SQL.transitionDraft
      ) return { rows: [{ id: RESOURCE_ID, resource_id: RESOURCE_ID }] };
      if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.hydrate) return { rows: hydratedRows() };
      if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.commit) {
        if (state.pending) {
          state.pending = false;
          state.committed = true;
        }
        state.commitCount += 1;
        releaseLock?.();
        releaseLock = null;
        return { rows: [] };
      }
      if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.rollback) {
        state.pending = false;
        releaseLock?.();
        releaseLock = null;
        return { rows: [] };
      }
      return { rows: [] };
    });
    return { query, release: jest.fn() } as unknown as PoolClient;
  };
  return {
    connect: async () => createClient(),
    state,
  };
}

function canonicalEndpointValidationQuery(endpointRows: Array<Record<string, unknown>>) {
  return jest.fn<QueryFn>().mockImplementation(async (sql, values) => {
    if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.begin) return { rows: [] };
    if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.statementTimeout || sql === TATOEBA_TRANSLATION_IMPORT_SQL.lockTimeout) {
      return { rows: [] };
    }
    if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.target) return { rows: targetRows() };
    if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.advisoryLock) return { rows: [] };
    if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.globalIdentityLookup) return { rows: [] };
    if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.actorUser) return { rows: actorRows() };
    if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.actorRoles) return { rows: [{ role_key: 'ADMIN' }] };
    if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.license) {
      const key = String(Array.isArray(values) ? values[0] : '');
      return { rows: licenseRow(key === 'CC0_1_0' ? 'CC0_1_0' : 'CC_BY_2_0_FR') };
    }
    if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.canonicalSentenceEndpointLookup) return { rows: endpointRows };
    if (sql === TATOEBA_TRANSLATION_IMPORT_SQL.rollback || sql === TATOEBA_TRANSLATION_IMPORT_SQL.commit) return { rows: [] };
    throw new Error('unexpected SQL in canonical endpoint validation test');
  });
}

async function expectCanonicalEndpointFailure(
  endpointRows: Array<Record<string, unknown>>,
  reason: string,
): Promise<void> {
  const query = canonicalEndpointValidationQuery(endpointRows);
  const { repository } = repositoryWith(query);
  await expect(repository.importTranslation(command)).resolves.toMatchObject({
    status: 'QUARANTINED',
    reason,
    durableResourceCreated: false,
  });
  const writeSql = [
    TATOEBA_TRANSLATION_IMPORT_SQL.insertResource,
    TATOEBA_TRANSLATION_IMPORT_SQL.insertTranslation,
    TATOEBA_TRANSLATION_IMPORT_SQL.insertProvenance,
    TATOEBA_TRANSLATION_IMPORT_SQL.updateTranslation,
    TATOEBA_TRANSLATION_IMPORT_SQL.updateProvenance,
    TATOEBA_TRANSLATION_IMPORT_SQL.insertSubmitAudit,
    TATOEBA_TRANSLATION_IMPORT_SQL.insertInvalidateAudit,
    TATOEBA_TRANSLATION_IMPORT_SQL.transitionDraft,
    TATOEBA_TRANSLATION_IMPORT_SQL.transitionVerified,
  ];
  expect(query.mock.calls.some(([sql]) => writeSql.includes(sql as typeof writeSql[number]))).toBe(false);
  expect(query.mock.calls.some(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.rollback)).toBe(true);
}

describe('PostgresTatoebaTranslationImportRepository', () => {
  it('uses directed lock and role-qualified identity lookup without contribution events or mutating SQL outside the contract', () => {
    const sql = Object.values(TATOEBA_TRANSLATION_IMPORT_SQL).join('\n');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('hashtextextended($1::text, 0)');
    expect(sql).toContain('source_id IN ($1, $2)');
    expect(sql).toContain('library_sentences AS sentence');
    expect(sql).toContain('FOR UPDATE OF resource');
    expect(sql).not.toContain('INSERT INTO library_sentences');
    expect(sql).toContain("resource_type::text AS resource_type");
    expect(sql).not.toContain('library_contribution_events');
  });

  it('creates one directed translation with two endpoint provenance rows, one SUBMIT audit, and COMMUNITY_REVIEW', async () => {
    const query = createQuery();
    const { repository, release } = repositoryWith(query);

    await expect(repository.importTranslation(command)).resolves.toEqual({
      status: 'CREATED',
      durableIdentity,
      inputPairIdentity: pairIdentity,
      resourceId: RESOURCE_ID,
      reviewState: 'COMMUNITY_REVIEW',
      durableResourceCreated: true,
    });
    expect(query.mock.calls.some(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.insertProvenance)).toBe(true);
    expect(query.mock.calls.filter(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.insertProvenance)).toHaveLength(2);
    expect(query.mock.calls.filter(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.insertSubmitAudit)).toHaveLength(1);
    expect(query.mock.calls.find(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.transitionDraft)?.[1]).toEqual([RESOURCE_ID, 2]);
    expect(query.mock.calls.find(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.canonicalSentenceEndpointLookup)?.[1]).toEqual([
      `TATOEBA:SENTENCE:${sourceId}`,
      `TATOEBA:SENTENCE:${targetId}`,
    ]);
    expect(release).toHaveBeenCalled();
  });

  it('fails closed when the source canonical SENTENCE endpoint is missing', async () => {
    await expectCanonicalEndpointFailure(canonicalSentenceRows().slice(1), 'TATOEBA_TRANSLATION_SOURCE_SENTENCE_NOT_FOUND');
  });

  it('fails closed when the target canonical SENTENCE endpoint is missing', async () => {
    await expectCanonicalEndpointFailure(canonicalSentenceRows().slice(0, 1), 'TATOEBA_TRANSLATION_TARGET_SENTENCE_NOT_FOUND');
  });

  it('fails closed when both canonical SENTENCE endpoints are missing', async () => {
    await expectCanonicalEndpointFailure([], 'TATOEBA_TRANSLATION_SOURCE_SENTENCE_NOT_FOUND');
  });

  it('fails closed when the source endpoint maps to a non-SENTENCE resource', async () => {
    await expectCanonicalEndpointFailure(
      canonicalSentenceRows({ source: { resource_type: 'VOCABULARY' } }),
      'TATOEBA_TRANSLATION_ENDPOINT_NOT_SENTENCE',
    );
  });

  it('fails closed when the target endpoint maps to a non-SENTENCE resource', async () => {
    await expectCanonicalEndpointFailure(
      canonicalSentenceRows({ target: { resource_type: 'VOCABULARY' } }),
      'TATOEBA_TRANSLATION_ENDPOINT_NOT_SENTENCE',
    );
  });

  it('fails closed when a canonical endpoint mapping is ambiguous', async () => {
    const rows = canonicalSentenceRows();
    await expectCanonicalEndpointFailure([
      rows[0],
      { ...rows[0], resource_id: '00000000-0000-4000-8000-000000000013' },
      rows[1],
    ], 'TATOEBA_TRANSLATION_SENTENCE_ENDPOINT_AMBIGUOUS');
  });

  it('fails closed when an external identity maps to unrelated canonical sentence facts', async () => {
    await expectCanonicalEndpointFailure(
      canonicalSentenceRows({ source: { text_content: 'Unrelated canonical sentence' } }),
      'TATOEBA_TRANSLATION_SENTENCE_ENDPOINT_MISMATCH',
    );
  });

  it('fails closed when both endpoint identities resolve to one canonical resource', async () => {
    await expectCanonicalEndpointFailure(
      canonicalSentenceRows({ target: { resource_id: SOURCE_SENTENCE_RESOURCE_ID } }),
      'TATOEBA_TRANSLATION_SENTENCE_RESOURCE_CONFLICT',
    );
  });

  it('rolls back and exposes a safe unavailable error when a write fails', async () => {
    const query = jest.fn<QueryFn>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: targetRows() })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: actorRows() })
      .mockResolvedValueOnce({ rows: [{ role_key: 'ADMIN' }] })
      .mockResolvedValueOnce({ rows: licenseRow('CC_BY_2_0_FR') })
      .mockResolvedValueOnce({ rows: licenseRow('CC0_1_0') })
      .mockResolvedValueOnce({ rows: canonicalSentenceRows() })
      .mockRejectedValueOnce(new Error('secret-password in driver failure'))
      .mockResolvedValueOnce({ rows: [] });
    const { repository } = repositoryWith(query);

    await expect(repository.importTranslation(command)).rejects.toMatchObject({
      code: 'TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE',
    });
    expect(query.mock.calls.some(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.rollback)).toBe(true);
  });

  it('quarantines incomplete or split role lookup without attempting actor/license validation', async () => {
    const query = jest.fn<QueryFn>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: targetRows() })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ resource_id: RESOURCE_ID, source_id: sourceProvenanceId }] })
      .mockResolvedValueOnce({ rows: [] });
    const { repository } = repositoryWith(query);

    await expect(repository.importTranslation(command)).resolves.toMatchObject({
      status: 'QUARANTINED',
      reason: 'TATOEBA_TRANSLATION_INTEGRITY_CONFLICT',
    });
    expect(query.mock.calls.some(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.actorUser)).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.rollback)).toBe(true);
  });

  it('reuses a matching COMMUNITY_REVIEW translation as an exact NOOP', async () => {
    const query = jest.fn<QueryFn>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: targetRows() })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [
        { resource_id: RESOURCE_ID, source_id: sourceProvenanceId },
        { resource_id: RESOURCE_ID, source_id: targetProvenanceId },
      ] })
      .mockResolvedValueOnce({ rows: actorRows() })
      .mockResolvedValueOnce({ rows: [{ role_key: 'ADMIN' }] })
      .mockResolvedValueOnce({ rows: licenseRow('CC_BY_2_0_FR') })
      .mockResolvedValueOnce({ rows: licenseRow('CC0_1_0') })
      .mockResolvedValueOnce({ rows: canonicalSentenceRows() })
      .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: stateRows() })
      .mockResolvedValueOnce({ rows: hydratedRows() })
      .mockResolvedValueOnce({ rows: [] });
    const { repository } = repositoryWith(query);

    await expect(repository.importTranslation(command)).resolves.toMatchObject({
      status: 'NOOP',
      resourceId: RESOURCE_ID,
      reviewState: 'COMMUNITY_REVIEW',
    });
    expect(query.mock.calls.some(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.updateTranslation)).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.insertSubmitAudit)).toBe(false);
  });

  it('reconciles a matching DRAFT exactly once and submits it without changing direction', async () => {
    const query = jest.fn<QueryFn>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: targetRows() })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [
        { resource_id: RESOURCE_ID, source_id: sourceProvenanceId },
        { resource_id: RESOURCE_ID, source_id: targetProvenanceId },
      ] })
      .mockResolvedValueOnce({ rows: actorRows() })
      .mockResolvedValueOnce({ rows: [{ role_key: 'ADMIN' }] })
      .mockResolvedValueOnce({ rows: licenseRow('CC_BY_2_0_FR') })
      .mockResolvedValueOnce({ rows: licenseRow('CC0_1_0') })
      .mockResolvedValueOnce({ rows: canonicalSentenceRows() })
      .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: stateRows('DRAFT') })
      .mockResolvedValueOnce({ rows: [{ id: '00000000-0000-4000-8000-000000000030' }] })
      .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: hydratedRows() })
      .mockResolvedValueOnce({ rows: [] });
    const { repository } = repositoryWith(query);

    await expect(repository.importTranslation(command)).resolves.toMatchObject({
      status: 'RECONCILED',
      resourceId: RESOURCE_ID,
      reviewState: 'COMMUNITY_REVIEW',
    });
    expect(query.mock.calls.filter(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.insertSubmitAudit)).toHaveLength(1);
    expect(query.mock.calls.find(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.transitionDraft)?.[1]).toEqual([RESOURCE_ID, 2]);
  });

  it('invalidates changed VERIFIED content before any translation/provenance rewrite', async () => {
    const changed = { ...command, candidate: { ...command.candidate, sourceText: 'Changed source' } };
    const canonicalRows = canonicalSentenceRows({ source: { text_content: changed.candidate.sourceText } });
    const query = jest.fn<QueryFn>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: targetRows() })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [
        { resource_id: RESOURCE_ID, source_id: sourceProvenanceId },
        { resource_id: RESOURCE_ID, source_id: targetProvenanceId },
      ] })
      .mockResolvedValueOnce({ rows: actorRows() })
      .mockResolvedValueOnce({ rows: [{ role_key: 'ADMIN' }] })
      .mockResolvedValueOnce({ rows: licenseRow('CC_BY_2_0_FR') })
      .mockResolvedValueOnce({ rows: licenseRow('CC0_1_0') })
      .mockResolvedValueOnce({ rows: canonicalRows })
      .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: stateRows('VERIFIED') })
      .mockResolvedValueOnce({ rows: [{ id: '00000000-0000-4000-8000-000000000040' }] })
      .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: hydratedRows() })
      .mockResolvedValueOnce({ rows: [] });
    const { repository } = repositoryWith(query);

    await expect(repository.importTranslation(changed)).resolves.toMatchObject({
      status: 'INVALIDATED',
      resourceId: RESOURCE_ID,
      reviewState: 'COMMUNITY_REVIEW',
    });
    expect(query.mock.calls.some(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.updateTranslation)).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.updateProvenance)).toBe(false);
    expect(query.mock.calls.filter(([sql]) => sql === TATOEBA_TRANSLATION_IMPORT_SQL.insertInvalidateAudit)).toHaveLength(1);
  });

  it('does not reopen a REJECTED translation when facts change', async () => {
    const changed = { ...command, candidate: { ...command.candidate, translatedText: 'Changed' } };
    const canonicalRows = canonicalSentenceRows({ target: { text_content: changed.candidate.translatedText } });
    const query = jest.fn<QueryFn>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: targetRows() })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [
        { resource_id: RESOURCE_ID, source_id: sourceProvenanceId },
        { resource_id: RESOURCE_ID, source_id: targetProvenanceId },
      ] })
      .mockResolvedValueOnce({ rows: actorRows() })
      .mockResolvedValueOnce({ rows: [{ role_key: 'ADMIN' }] })
      .mockResolvedValueOnce({ rows: licenseRow('CC_BY_2_0_FR') })
      .mockResolvedValueOnce({ rows: licenseRow('CC0_1_0') })
      .mockResolvedValueOnce({ rows: canonicalRows })
      .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: stateRows('REJECTED') })
      .mockResolvedValueOnce({ rows: [] });
    const { repository } = repositoryWith(query);

    await expect(repository.importTranslation(changed)).resolves.toMatchObject({
      status: 'QUARANTINED',
      reason: 'TATOEBA_TRANSLATION_REJECTED_NO_REOPEN',
    });
  });

  it('serializes concurrent identical directed retries so only one durable resource is created', async () => {
    const pool = concurrentPool();
    const repository = new PostgresTatoebaTranslationImportRepository(pool, 'congdongngonngu_test', 'readonly_test');

    const results = await Promise.all([
      repository.importTranslation(command),
      repository.importTranslation(command),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['CREATED', 'NOOP']);
    expect(results.every((result) => result.durableIdentity === durableIdentity)).toBe(true);
    expect(pool.state.commitCount).toBe(2);
  });
});
