import type { PoolClient } from 'pg';
import { describe, expect, it, jest } from '@jest/globals';

import { buildTatoebaAttribution, sentenceSourceUrl } from './tatoeba.attribution';
import {
  PostgresTatoebaSentenceImportRepository,
  TATOEBA_SENTENCE_IMPORT_SQL,
} from './postgres-tatoeba-sentence-import.repository';
import type { TatoebaSentenceImportCommand } from './tatoeba-sentence-import.types';

const ACTOR_ID = '00000000-0000-4000-8000-000000000001';
const RESOURCE_ID = '00000000-0000-4000-8000-000000000010';

const command: TatoebaSentenceImportCommand = {
  actorUserId: ACTOR_ID,
  candidate: {
    provider: 'TATOEBA',
    sentenceId: '123',
    projectLanguage: 'vi',
    text: 'Xin chào',
    license: 'CC BY 2.0 FR',
    owner: 'alice',
    sourceUrl: sentenceSourceUrl('123'),
    sourceIdentity: 'TATOEBA:SENTENCE:123',
    attribution: buildTatoebaAttribution({
      sentenceId: '123',
      sourceUrl: sentenceSourceUrl('123'),
      license: 'CC BY 2.0 FR',
      owner: 'alice',
      transformationNote: null,
    }),
    importBatch: 'tatoeba-08d3a-test',
    snapshotId: 'TATOEBA-SNAPSHOT-test',
    apiCheckedAt: '2026-09-28T00:00:01.000Z',
    transformationNote: null,
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

function hydratedRows(reviewState = 'COMMUNITY_REVIEW') {
  return [{
    resource_id: RESOURCE_ID,
    resource_type: 'SENTENCE',
    review_state: reviewState,
    project_language: 'vi',
    text_content: command.candidate.text,
    source_id: command.candidate.sourceIdentity,
  }];
}

function repositoryWith(query: QueryFn, release = jest.fn()) {
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: async () => client };
  return {
    repository: new PostgresTatoebaSentenceImportRepository(pool, 'congdongngonngu_test', 'readonly_test'),
    client,
    release,
  };
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

function concurrentFakePool() {
  const mutex = new AsyncMutex();
  const state = { committed: false, pending: false, commitCount: 0 };

  const createClient = (): PoolClient => {
    let releaseLock: (() => void) | null = null;
    const query = jest.fn<QueryFn>().mockImplementation(async (sql, values) => {
      if (sql === TATOEBA_SENTENCE_IMPORT_SQL.advisoryLock) {
        releaseLock = await mutex.acquire();
        return { rows: [] };
      }
      if (sql === TATOEBA_SENTENCE_IMPORT_SQL.target) return { rows: targetRows() };
      if (sql === TATOEBA_SENTENCE_IMPORT_SQL.globalIdentityLookup) {
        return { rows: state.committed ? [{ resource_id: RESOURCE_ID }] : [] };
      }
      if (sql === TATOEBA_SENTENCE_IMPORT_SQL.actorUser) return { rows: actorRows() };
      if (sql === TATOEBA_SENTENCE_IMPORT_SQL.actorRoles) return { rows: [{ role_key: 'ADMIN' }] };
      if (sql === TATOEBA_SENTENCE_IMPORT_SQL.license) {
        const key = String(Array.isArray(values) ? values[0] : '');
        return { rows: licenseRow(key === 'CC0_1_0' ? 'CC0_1_0' : 'CC_BY_2_0_FR') };
      }
      if (sql === TATOEBA_SENTENCE_IMPORT_SQL.resourceLock) return { rows: [{ id: RESOURCE_ID }] };
      if (sql === TATOEBA_SENTENCE_IMPORT_SQL.resourceState) {
        return { rows: [{
          resource_id: RESOURCE_ID,
          resource_type: 'SENTENCE',
          review_state: 'COMMUNITY_REVIEW',
          provenance_revision: '1',
          project_language: 'vi',
          text_content: command.candidate.text,
          source_id: command.candidate.sourceIdentity,
          source_url: command.candidate.sourceUrl,
          license_key: 'CC_BY_2_0_FR',
          attribution: command.candidate.attribution,
          original_author_reference: 'alice',
          import_batch: command.candidate.importBatch,
          transformation_history: [{ metadata: { snapshotId: command.candidate.snapshotId } }],
        }] };
      }
      if (sql === TATOEBA_SENTENCE_IMPORT_SQL.insertResource) {
        state.pending = true;
        return { rows: [{ id: RESOURCE_ID }] };
      }
      if (
        sql === TATOEBA_SENTENCE_IMPORT_SQL.insertSentence
        || sql === TATOEBA_SENTENCE_IMPORT_SQL.insertProvenance
        || sql === TATOEBA_SENTENCE_IMPORT_SQL.insertSubmitAudit
        || sql === TATOEBA_SENTENCE_IMPORT_SQL.transitionDraft
      ) return { rows: [{ id: RESOURCE_ID, resource_id: RESOURCE_ID }] };
      if (sql === TATOEBA_SENTENCE_IMPORT_SQL.hydrate) return { rows: hydratedRows() };
      if (sql === TATOEBA_SENTENCE_IMPORT_SQL.commit) {
        if (state.pending) {
          state.committed = true;
          state.pending = false;
        }
        state.commitCount += 1;
        releaseLock?.();
        releaseLock = null;
        return { rows: [] };
      }
      if (sql === TATOEBA_SENTENCE_IMPORT_SQL.rollback) {
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

describe('PostgresTatoebaSentenceImportRepository', () => {
  it('uses the exact sentence lock/global identity contract and never emits a contribution event', () => {
    const sql = Object.values(TATOEBA_SENTENCE_IMPORT_SQL).join('\n');
    expect(sql).toContain('BEGIN');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('hashtextextended($1::text, 0)');
    expect(sql).toContain("source_type = 'OPEN_DATASET'::library_source_type");
    expect(sql).toContain('source_id = $1');
    expect(sql).toContain('library_resource_review_audits');
    expect(sql).not.toContain('library_contribution_events');
  });

  it('creates a sentence, provenance, SUBMIT audit, and COMMUNITY_REVIEW state atomically', async () => {
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
      .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: [{ resource_id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: '00000000-0000-4000-8000-000000000020' }] })
      .mockResolvedValueOnce({ rows: [{ id: '00000000-0000-4000-8000-000000000030' }] })
      .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
       .mockResolvedValueOnce({ rows: hydratedRows() })
      .mockResolvedValueOnce({ rows: [] });
    const { repository, release } = repositoryWith(query);

    await expect(repository.importSentence(command)).resolves.toEqual({
      status: 'CREATED',
      sourceIdentity: 'TATOEBA:SENTENCE:123',
      resourceId: RESOURCE_ID,
      reviewState: 'COMMUNITY_REVIEW',
      durableResourceCreated: true,
    });

    expect(query.mock.calls[4]).toEqual([
      TATOEBA_SENTENCE_IMPORT_SQL.advisoryLock,
      ['OPEN_DATASET:TATOEBA:SENTENCE:123'],
    ]);
    expect(query.mock.calls[5]).toEqual([
      TATOEBA_SENTENCE_IMPORT_SQL.globalIdentityLookup,
      ['TATOEBA:SENTENCE:123'],
    ]);
    expect(query.mock.calls[12][0]).toBe(TATOEBA_SENTENCE_IMPORT_SQL.insertProvenance);
    expect(query.mock.calls[12][1]).toEqual(expect.arrayContaining([
      RESOURCE_ID,
      'TATOEBA:SENTENCE:123',
      command.candidate.sourceUrl,
      'CC_BY_2_0_FR',
      command.candidate.attribution,
      'alice',
      'tatoeba-08d3a-test',
    ]));
    expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('library_contribution_events'))).toBe(false);
    expect(query).toHaveBeenLastCalledWith(TATOEBA_SENTENCE_IMPORT_SQL.commit);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('returns an unchanged rerun as NOOP without resource, provenance, audit, or update SQL', async () => {
    const query = jest.fn<QueryFn>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: targetRows() })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ resource_id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: actorRows() })
      .mockResolvedValueOnce({ rows: [{ role_key: 'ADMIN' }] })
      .mockResolvedValueOnce({ rows: licenseRow('CC_BY_2_0_FR') })
      .mockResolvedValueOnce({ rows: licenseRow('CC0_1_0') })
      .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: [{
        resource_id: RESOURCE_ID,
        resource_type: 'SENTENCE',
        review_state: 'COMMUNITY_REVIEW',
        provenance_revision: '1',
        project_language: 'vi',
        text_content: command.candidate.text,
        source_id: command.candidate.sourceIdentity,
        source_url: command.candidate.sourceUrl,
        license_key: 'CC_BY_2_0_FR',
        attribution: command.candidate.attribution,
        original_author_reference: 'alice',
        import_batch: command.candidate.importBatch,
        transformation_history: [{ metadata: { snapshotId: command.candidate.snapshotId } }],
      }] })
       .mockResolvedValueOnce({ rows: hydratedRows() })
      .mockResolvedValueOnce({ rows: [] });
    const { repository } = repositoryWith(query);

    await expect(repository.importSentence(command)).resolves.toMatchObject({
      status: 'NOOP',
      resourceId: RESOURCE_ID,
      reviewState: 'COMMUNITY_REVIEW',
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).not.toContain(TATOEBA_SENTENCE_IMPORT_SQL.insertResource);
    expect(statements).not.toContain(TATOEBA_SENTENCE_IMPORT_SQL.insertSentence);
    expect(statements).not.toContain(TATOEBA_SENTENCE_IMPORT_SQL.insertProvenance);
    expect(statements).not.toContain(TATOEBA_SENTENCE_IMPORT_SQL.insertSubmitAudit);
    expect(statements).not.toContain(TATOEBA_SENTENCE_IMPORT_SQL.updateSentence);
    expect(statements).not.toContain(TATOEBA_SENTENCE_IMPORT_SQL.updateProvenance);
    expect(statements).not.toContain(TATOEBA_SENTENCE_IMPORT_SQL.transitionDraft);
  });

  it('rolls back all work and sanitizes an unexpected database error', async () => {
    const rawSecret = 'postgresql://leak-user:leak-password@leak.example/db?token=leak-token';
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
      .mockRejectedValueOnce(new Error(`insert failed: ${rawSecret}`))
      .mockResolvedValueOnce({ rows: [] });
    const { repository } = repositoryWith(query);

    const result = await repository.importSentence(command).catch((error: unknown) => error as Error);
    expect(result).toMatchObject({
      code: 'TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE',
      message: 'Tatoeba sentence import database access failed closed.',
    });
    expect((result as Error).message).not.toContain(rawSecret);
    expect(query).toHaveBeenLastCalledWith(TATOEBA_SENTENCE_IMPORT_SQL.rollback);
  });

  it('quarantines an actor that is not ADMIN and writes no Library rows', async () => {
    const query = jest.fn<QueryFn>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: targetRows() })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: actorRows() })
      .mockResolvedValueOnce({ rows: [{ role_key: 'MEMBER' }] })
      .mockResolvedValueOnce({ rows: [] });
    const { repository } = repositoryWith(query);

    await expect(repository.importSentence(command)).resolves.toMatchObject({
      status: 'QUARANTINED',
      reason: 'TATOEBA_IMPORT_ACTOR_NOT_ADMIN',
      durableResourceCreated: false,
    });
    expect(query).toHaveBeenLastCalledWith(TATOEBA_SENTENCE_IMPORT_SQL.rollback);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO library_'))).toBe(false);
  });

  it('fails closed on a missing required license before any resource write', async () => {
    const query = jest.fn<QueryFn>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: targetRows() })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: actorRows() })
      .mockResolvedValueOnce({ rows: [{ role_key: 'ADMIN' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { repository } = repositoryWith(query);

    await expect(repository.importSentence(command)).resolves.toMatchObject({
      status: 'QUARANTINED',
      reason: 'TATOEBA_LICENSE_REGISTRY_MISSING',
      durableResourceCreated: false,
    });
    expect(query).toHaveBeenLastCalledWith(TATOEBA_SENTENCE_IMPORT_SQL.rollback);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO library_'))).toBe(false);
  });

  it('reconciles changed safe facts in COMMUNITY_REVIEW while preserving exact candidate text', async () => {
    const changedCommand: TatoebaSentenceImportCommand = {
      ...command,
      candidate: { ...command.candidate, text: '  Xin chào  ' },
    };
    const query = jest.fn<QueryFn>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: targetRows() })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ resource_id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: actorRows() })
      .mockResolvedValueOnce({ rows: [{ role_key: 'ADMIN' }] })
      .mockResolvedValueOnce({ rows: licenseRow('CC_BY_2_0_FR') })
      .mockResolvedValueOnce({ rows: licenseRow('CC0_1_0') })
      .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: [{
        resource_id: RESOURCE_ID,
        resource_type: 'SENTENCE',
        review_state: 'COMMUNITY_REVIEW',
        provenance_revision: '1',
        project_language: 'vi',
        text_content: command.candidate.text,
        source_id: command.candidate.sourceIdentity,
        source_url: command.candidate.sourceUrl,
        license_key: 'CC_BY_2_0_FR',
        attribution: command.candidate.attribution,
        original_author_reference: 'alice',
        import_batch: command.candidate.importBatch,
        transformation_history: [{ metadata: { snapshotId: command.candidate.snapshotId } }],
      }] })
      .mockResolvedValueOnce({ rows: [{ resource_id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: '00000000-0000-4000-8000-000000000020' }] })
      .mockResolvedValueOnce({ rows: [{ ...hydratedRows()[0], text_content: changedCommand.candidate.text }] })
      .mockResolvedValueOnce({ rows: [] });
    const { repository } = repositoryWith(query);

    await expect(repository.importSentence(changedCommand)).resolves.toMatchObject({
      status: 'RECONCILED',
      resourceId: RESOURCE_ID,
      reviewState: 'COMMUNITY_REVIEW',
    });
    expect(query.mock.calls[12]).toEqual([
      TATOEBA_SENTENCE_IMPORT_SQL.updateSentence,
      [RESOURCE_ID, '  Xin chào  '],
    ]);
  });

  it('submits a pre-existing importer-owned DRAFT only after the dedicated audit boundary', async () => {
    const query = jest.fn<QueryFn>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: targetRows() })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ resource_id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: actorRows() })
      .mockResolvedValueOnce({ rows: [{ role_key: 'ADMIN' }] })
      .mockResolvedValueOnce({ rows: licenseRow('CC_BY_2_0_FR') })
      .mockResolvedValueOnce({ rows: licenseRow('CC0_1_0') })
      .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: [{
        resource_id: RESOURCE_ID,
        resource_type: 'SENTENCE',
        review_state: 'DRAFT',
        provenance_revision: '1',
        project_language: 'vi',
        text_content: command.candidate.text,
        source_id: command.candidate.sourceIdentity,
        source_url: command.candidate.sourceUrl,
        license_key: 'CC_BY_2_0_FR',
        attribution: command.candidate.attribution,
        original_author_reference: 'alice',
        import_batch: command.candidate.importBatch,
        transformation_history: [{ metadata: { snapshotId: command.candidate.snapshotId } }],
      }] })
      .mockResolvedValueOnce({ rows: [{ id: '00000000-0000-4000-8000-000000000020' }] })
      .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: hydratedRows() })
      .mockResolvedValueOnce({ rows: [] });
    const { repository } = repositoryWith(query);

    await expect(repository.importSentence(command)).resolves.toMatchObject({
      status: 'RECONCILED',
      resourceId: RESOURCE_ID,
      reviewState: 'COMMUNITY_REVIEW',
    });
    expect(query.mock.calls[12][0]).toBe(TATOEBA_SENTENCE_IMPORT_SQL.insertSubmitAudit);
    expect(query.mock.calls[13][0]).toBe(TATOEBA_SENTENCE_IMPORT_SQL.transitionDraft);
  });

  it('invalidates a changed VERIFIED sentence without silently rewriting its content', async () => {
    const changedCommand: TatoebaSentenceImportCommand = {
      ...command,
      candidate: { ...command.candidate, text: 'Changed exact text' },
    };
    const query = jest.fn<QueryFn>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: targetRows() })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ resource_id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: actorRows() })
      .mockResolvedValueOnce({ rows: [{ role_key: 'ADMIN' }] })
      .mockResolvedValueOnce({ rows: licenseRow('CC_BY_2_0_FR') })
      .mockResolvedValueOnce({ rows: licenseRow('CC0_1_0') })
      .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: [{
        resource_id: RESOURCE_ID,
        resource_type: 'SENTENCE',
        review_state: 'VERIFIED',
        provenance_revision: '1',
        project_language: 'vi',
        text_content: command.candidate.text,
        source_id: command.candidate.sourceIdentity,
        source_url: command.candidate.sourceUrl,
        license_key: 'CC_BY_2_0_FR',
        attribution: command.candidate.attribution,
        original_author_reference: 'alice',
        import_batch: command.candidate.importBatch,
        transformation_history: [{ metadata: { snapshotId: command.candidate.snapshotId } }],
      }] })
      .mockResolvedValueOnce({ rows: [{ id: '00000000-0000-4000-8000-000000000030' }] })
      .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })
      .mockResolvedValueOnce({ rows: hydratedRows() })
      .mockResolvedValueOnce({ rows: [] });
    const { repository } = repositoryWith(query);

    await expect(repository.importSentence(changedCommand)).resolves.toMatchObject({
      status: 'INVALIDATED',
      resourceId: RESOURCE_ID,
      reviewState: 'COMMUNITY_REVIEW',
    });
    expect(query.mock.calls.some(([sql]) => sql === TATOEBA_SENTENCE_IMPORT_SQL.updateSentence)).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql === TATOEBA_SENTENCE_IMPORT_SQL.updateProvenance)).toBe(false);
  });

  it('serializes concurrent same-sentence runs so one creates and the other reconciles to NOOP', async () => {
    const pool = concurrentFakePool();
    const repository = new PostgresTatoebaSentenceImportRepository(pool, 'congdongngonngu_test', 'readonly_test');

    const results = await Promise.all([
      repository.importSentence(command),
      repository.importSentence(command),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['CREATED', 'NOOP']);
    expect(results.every((result) => result.sourceIdentity === command.candidate.sourceIdentity)).toBe(true);
    expect(pool.state.commitCount).toBe(2);
    expect(pool.state.committed).toBe(true);
  });
});
