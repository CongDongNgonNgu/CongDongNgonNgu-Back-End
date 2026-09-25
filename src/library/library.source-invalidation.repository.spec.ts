import type { Pool } from 'pg';
import { PostgresLibraryRepository } from './postgres-library.repository';

type MockQueryResult = { rows: Array<Record<string, unknown>> } | Error;

describe('PostgresLibraryRepository Phase 06 source transactions', () => {
  it('locks and validates Phase 06 source rows before updating VERIFIED state', async () => {
    const ids = fixtureIds();
    const occurredAt = new Date('2026-09-25T00:00:00.000Z');
    const calls = successfulVerifyCalls(ids, occurredAt);
    const clientQuery = jest.fn();
    for (const call of calls) {
      if (call instanceof Error) clientQuery.mockRejectedValueOnce(call);
      else clientQuery.mockResolvedValueOnce(call);
    }
    const client = { query: clientQuery, release: jest.fn() };
    const repository = repositoryFor(client);

    const result = await repository.transitionReview({
      resourceId: ids.resourceId,
      expectedPreviousState: 'COMMUNITY_REVIEW',
      expectedProvenanceRevision: 3,
      nextState: 'VERIFIED',
      action: 'VERIFY',
      actorUserId: ids.reviewerId,
      note: null,
      occurredAt,
    });

    expect(result.resource.reviewState).toBe('VERIFIED');
    const sql = clientQuery.mock.calls.map(([query]) => String(query));
    expect(sql[1]).toContain('FROM library_resources');
    expect(sql[1]).toContain('FOR UPDATE');
    expect(sql[2]).toContain('library_resource_provenance');
    expect(sql[2]).toContain('FOR SHARE');
    expect(sql[3]).toContain('library_licenses');
    expect(sql[3]).toContain('FOR SHARE');
    expect(sql[4]).toContain('community_posts');
    expect(sql[4]).toContain('FOR SHARE');
    expect(sql[5]).toContain('community_structured_responses');
    expect(sql[5]).toContain('FOR SHARE');
    expect(sql[6]).toContain('community_structured_response_acceptances');
    expect(sql[6]).toContain('FOR SHARE');
    expect(sql[7]).toContain('community_library_candidates');
    expect(sql[7]).toContain('FOR SHARE');
    expect(sql[8]).toContain('UPDATE library_resources');
    expect(sql[9]).toContain('library_resource_review_audits');
    expect(sql[10]).toContain('resource.*');
    expect(sql.at(-1)).toBe('COMMIT');
    expect(clientQuery.mock.calls.slice(-1)[0][0]).toBe('COMMIT');
  });

  it('rolls back before the resource update when the Phase 06 source is invalid', async () => {
    const ids = fixtureIds();
    const occurredAt = new Date('2026-09-25T00:00:00.000Z');
    const calls = successfulVerifyCalls(ids, occurredAt);
    calls[7] = { rows: [{
      id: ids.candidateId,
      state: 'INVALIDATED',
      source_post_id: ids.postId,
      source_response_id: ids.responseId,
      acceptance_id: ids.acceptanceId,
    }] };
    calls.splice(8);
    calls.push({ rows: [] });
    const clientQuery = jest.fn();
    for (const call of calls) clientQuery.mockResolvedValueOnce(call);
    const client = { query: clientQuery, release: jest.fn() };
    const repository = repositoryFor(client);

    await expect(repository.transitionReview({
      resourceId: ids.resourceId,
      expectedPreviousState: 'COMMUNITY_REVIEW',
      expectedProvenanceRevision: 3,
      nextState: 'VERIFIED',
      action: 'VERIFY',
      actorUserId: ids.reviewerId,
      note: null,
      occurredAt,
    })).rejects.toMatchObject({ code: 'LIBRARY_SOURCE_INVALID' });
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE library_resources'))).toBe(false);
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('hydrates reconciliation through the transaction client and commits once', async () => {
    const ids = fixtureIds();
    const occurredAt = new Date('2026-09-25T00:00:00.000Z');
    const calls = successfulReconcileCalls(ids, occurredAt);
    const clientQuery = jest.fn();
    for (const call of calls) clientQuery.mockResolvedValueOnce(call);
    const client = { query: clientQuery, release: jest.fn() };
    const repository = repositoryFor(client);

    const result = await repository.reconcileSource({
      resourceId: ids.resourceId,
      expectedPreviousState: 'VERIFIED',
      expectedProvenanceRevision: 3,
      actorUserId: ids.reviewerId,
      note: 'Phase 06 source invalid: CANDIDATE_INVALIDATED',
      sourceReasons: ['CANDIDATE_INVALIDATED'],
      occurredAt,
    });

    expect(result).toMatchObject({
      resource: { reviewState: 'COMMUNITY_REVIEW' },
      audit: { action: 'INVALIDATE' },
    });
    const sql = clientQuery.mock.calls.map(([query]) => String(query));
    expect(sql[7]).toContain('UPDATE library_resources');
    expect(sql[8]).toContain('library_resource_review_audits');
    expect(sql[9]).toContain('resource.*');
    expect(sql.at(-1)).toBe('COMMIT');
    expect(sql.slice(sql.indexOf('COMMIT') + 1)).toEqual([]);
  });

  it('rolls back reconciliation when final hydration fails', async () => {
    const ids = fixtureIds();
    const occurredAt = new Date('2026-09-25T00:00:00.000Z');
    const calls = successfulReconcileCalls(ids, occurredAt);
    calls[9] = new Error('hydration failed');
    calls.splice(10);
    calls.push({ rows: [] });
    const clientQuery = jest.fn();
    for (const call of calls) {
      if (call instanceof Error) clientQuery.mockRejectedValueOnce(call);
      else clientQuery.mockResolvedValueOnce(call);
    }
    const client = { query: clientQuery, release: jest.fn() };
    const repository = repositoryFor(client);

    await expect(repository.reconcileSource({
      resourceId: ids.resourceId,
      expectedPreviousState: 'VERIFIED',
      expectedProvenanceRevision: 3,
      actorUserId: ids.reviewerId,
      note: 'Phase 06 source invalid: CANDIDATE_INVALIDATED',
      sourceReasons: ['CANDIDATE_INVALIDATED'],
      occurredAt,
    })).rejects.toThrow('hydration failed');
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE library_resources'))).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('library_resource_review_audits'))).toBe(true);
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});

function repositoryFor(client: {
  query: (...args: any[]) => any;
  release: (...args: any[]) => any;
}): PostgresLibraryRepository {
  return new PostgresLibraryRepository({
    query: jest.fn(),
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as Pool);
}

function successfulVerifyCalls(ids: ReturnType<typeof fixtureIds>, occurredAt: Date): MockQueryResult[] {
  return [
    { rows: [] },
    { rows: [resourceRow(ids.resourceId, 'COMMUNITY_REVIEW', occurredAt, 3)] },
    { rows: [provenanceRow(ids.resourceId, ids, occurredAt)] },
    { rows: [{ license_key: 'SOURCE-SAFE', active: true, redistribution_allowed: true }] },
    { rows: [{ id: ids.postId, moderation_state: 'ACTIVE', visibility: 'PUBLIC' }] },
    { rows: [{ id: ids.responseId, parent_post_id: ids.postId, moderation_state: 'ACTIVE' }] },
    { rows: [{ id: ids.acceptanceId, parent_post_id: ids.postId, response_id: ids.responseId, revoked_at: null }] },
    { rows: [{ id: ids.candidateId, state: 'PENDING_REVIEW', source_post_id: ids.postId, source_response_id: ids.responseId, acceptance_id: ids.acceptanceId }] },
    { rows: [resourceRow(ids.resourceId, 'VERIFIED', occurredAt, 3, ids.reviewerId)] },
    { rows: [auditRow(ids, occurredAt, 'VERIFY', 'COMMUNITY_REVIEW', 'VERIFIED')] },
    { rows: [resourceRow(ids.resourceId, 'VERIFIED', occurredAt, 3, ids.reviewerId)] },
    { rows: [] },
    { rows: [provenanceRow(ids.resourceId, ids, occurredAt)] },
    { rows: [{ term: 'source', definition: 'source meaning', part_of_speech: null, example_sentence: null }] },
  ];
}

function successfulReconcileCalls(ids: ReturnType<typeof fixtureIds>, occurredAt: Date): MockQueryResult[] {
  return [
    { rows: [] },
    { rows: [resourceRow(ids.resourceId, 'VERIFIED', occurredAt, 3, ids.reviewerId)] },
    { rows: [provenanceRow(ids.resourceId, ids, occurredAt)] },
    { rows: [{ id: ids.postId, moderation_state: 'ACTIVE', visibility: 'PRIVATE' }] },
    { rows: [{ id: ids.responseId, parent_post_id: ids.postId, moderation_state: 'ACTIVE' }] },
    { rows: [{ id: ids.acceptanceId, parent_post_id: ids.postId, response_id: ids.responseId, revoked_at: null }] },
    { rows: [{ id: ids.candidateId, state: 'PENDING_REVIEW', source_post_id: ids.postId, source_response_id: ids.responseId, acceptance_id: ids.acceptanceId }] },
    { rows: [resourceRow(ids.resourceId, 'COMMUNITY_REVIEW', occurredAt, 3)] },
    { rows: [auditRow(ids, occurredAt, 'INVALIDATE', 'VERIFIED', 'COMMUNITY_REVIEW')] },
    { rows: [resourceRow(ids.resourceId, 'COMMUNITY_REVIEW', occurredAt, 3)] },
    { rows: [] },
    { rows: [provenanceRow(ids.resourceId, ids, occurredAt)] },
    { rows: [{ term: 'source', definition: 'source meaning', part_of_speech: null, example_sentence: null }] },
  ];
}

function fixtureIds() {
  return {
    resourceId: uuid(1),
    reviewerId: uuid(2),
    candidateId: uuid(3),
    postId: uuid(4),
    responseId: uuid(5),
    acceptanceId: uuid(6),
  };
}

function resourceRow(
  resourceId: string,
  reviewState: string,
  occurredAt: Date,
  provenanceRevision: number,
  reviewedByUserId: string | null = null,
) {
  return {
    id: resourceId,
    resource_type: 'VOCABULARY',
    primary_language_id: uuid(10),
    secondary_language_id: null,
    cefr_level: null,
    created_by_user_id: uuid(11),
    visibility: 'PUBLIC',
    moderation_state: 'ACTIVE',
    review_state: reviewState,
    created_at: occurredAt,
    updated_at: occurredAt,
    reviewed_by_user_id: reviewedByUserId,
    reviewed_at: reviewedByUserId ? occurredAt : null,
    provenance_revision: String(provenanceRevision),
    primary_language_code: 'en',
    secondary_language_code: null,
  };
}

function provenanceRow(resourceId: string, ids: ReturnType<typeof fixtureIds>, occurredAt: Date) {
  return {
    id: uuid(12),
    resource_id: resourceId,
    source_type: 'PHASE06_LIBRARY_CANDIDATE',
    source_id: ids.candidateId,
    source_url: null,
    license_key: 'SOURCE-SAFE',
    attribution: 'Phase 06 contributor',
    original_author_reference: null,
    original_contributor_user_id: null,
    import_batch: null,
    transformation_history: [],
    source_post_id: ids.postId,
    source_response_id: ids.responseId,
    source_candidate_id: ids.candidateId,
    source_acceptance_id: ids.acceptanceId,
    created_at: occurredAt,
    updated_at: occurredAt,
    license_display_name: 'Safe source license',
    license_canonical_url: 'https://licenses.example.test/source-safe',
    license_attribution_required: true,
    license_redistribution_allowed: true,
    license_derivative_constraints: null,
    license_active: true,
    license_source_note: 'private source note',
    license_created_at: occurredAt,
    license_updated_at: occurredAt,
  };
}

function auditRow(
  ids: ReturnType<typeof fixtureIds>,
  occurredAt: Date,
  action: string,
  previousState: string,
  newState: string,
) {
  return {
    id: uuid(13),
    resource_id: ids.resourceId,
    actor_user_id: ids.reviewerId,
    previous_state: previousState,
    new_state: newState,
    action,
    note: action === 'INVALIDATE' ? 'Phase 06 source invalid: CANDIDATE_INVALIDATED' : null,
    created_at: occurredAt,
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}
