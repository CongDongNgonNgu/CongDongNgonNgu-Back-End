import type { Pool } from 'pg';
import { PostgresLibraryRepository } from './postgres-library.repository';

describe('PostgresLibraryRepository community contribution transaction', () => {
  it('locks current licenses and hydrates the result before committing one transaction', async () => {
    const resourceId = '00000000-0000-4000-8000-000000000001';
    const contributorUserId = '00000000-0000-4000-8000-000000000002';
    const auditId = '00000000-0000-4000-8000-000000000003';
    const eventId = '00000000-0000-4000-8000-000000000004';
    const occurredAt = new Date('2026-09-24T00:00:00.000Z');
    const updatedRow = resourceRow(resourceId, contributorUserId, occurredAt);
    const auditRow = {
      id: auditId,
      resource_id: resourceId,
      actor_user_id: contributorUserId,
      previous_state: 'DRAFT',
      new_state: 'COMMUNITY_REVIEW',
      action: 'SUBMIT',
      note: null,
      created_at: occurredAt,
    };
    const eventRow = {
      id: eventId,
      event_type: 'LIBRARY_CONTRIBUTION_SUBMITTED',
      event_version: 1,
      resource_id: resourceId,
      contributor_user_id: contributorUserId,
      review_audit_id: auditId,
      resource_type: 'VOCABULARY',
      terms_version: 'library-contribution-v1',
      rights_confirmed: true,
      reuse_consent: true,
      occurred_at: occurredAt,
      created_at: occurredAt,
    };
    const hydratedProvenanceRow = transactionProvenanceRow(resourceId, contributorUserId, occurredAt);
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [updatedRow] })
      .mockResolvedValueOnce({ rows: [transactionProvenanceRow(resourceId, contributorUserId, occurredAt)] })
      .mockResolvedValueOnce({ rows: [licenseRow()] })
      .mockResolvedValueOnce({ rows: [auditRow] })
      .mockResolvedValueOnce({ rows: [eventRow] })
      .mockResolvedValueOnce({ rows: [updatedRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [hydratedProvenanceRow] })
      .mockResolvedValueOnce({ rows: [{ term: 'word', definition: 'meaning', part_of_speech: null, example_sentence: null }] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: jest.fn() };
    const poolQuery = jest.fn();
    const repository = new PostgresLibraryRepository({
      query: poolQuery,
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool);

    const result = await repository.submitContribution({
      resourceId,
      expectedProvenanceRevision: 1,
      contributorUserId,
      resourceType: 'VOCABULARY',
      termsVersion: 'library-contribution-v1',
      rightsConfirmed: true,
      reuseConsent: true,
      occurredAt,
    });

    expect(result).toMatchObject({
      resource: { id: resourceId, reviewState: 'COMMUNITY_REVIEW' },
      audit: { id: auditId, action: 'SUBMIT' },
      event: {
        id: eventId,
        reviewAuditId: auditId,
        contributorUserId,
        rightsConfirmed: true,
        reuseConsent: true,
      },
    });
    expect(clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(clientQuery).toHaveBeenNthCalledWith(11, 'COMMIT');
    expect(clientQuery.mock.calls[1][0]).toContain("review_state = 'COMMUNITY_REVIEW'::library_review_state");
    expect(clientQuery.mock.calls[1][0]).toContain('created_by_user_id = $3::uuid');
    expect(clientQuery.mock.calls[1][0]).toContain("visibility = 'PUBLIC'::community_post_visibility");
    expect(clientQuery.mock.calls[1][0]).toContain("moderation_state = 'ACTIVE'::community_moderation_state");
    expect(clientQuery.mock.calls[2][0]).toContain('library_resource_provenance');
    expect(clientQuery.mock.calls[3][0]).toContain('FOR SHARE');
    expect(clientQuery.mock.calls[3][1]).toEqual([['SAFE-V1']]);
    expect(clientQuery.mock.calls[5][0]).toContain('library_contribution_events');
    expect(clientQuery.mock.calls[5][0]).not.toContain('details');
    expect(clientQuery.mock.calls[6][0]).toContain('resource.*');
    expect(clientQuery.mock.calls.slice(11)).toHaveLength(0);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('rolls back the review transition and audit when the event insert fails', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'resource-1' }] })
      .mockResolvedValueOnce({ rows: [transactionProvenanceRow('resource-1', '00000000-0000-4000-8000-000000000002')] })
      .mockResolvedValueOnce({ rows: [licenseRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'audit-1' }] })
      .mockRejectedValueOnce(new Error('event insert failed'))
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: jest.fn() };
    const repository = new PostgresLibraryRepository({
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool);

    await expect(repository.submitContribution(validRepositoryInput())).rejects.toThrow('event insert failed');
    expect(clientQuery).toHaveBeenNthCalledWith(7, 'ROLLBACK');
    expect(clientQuery.mock.calls[5][0]).toContain('library_contribution_events');
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back the resource transition when the review audit insert fails', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'resource-1' }] })
      .mockResolvedValueOnce({ rows: [transactionProvenanceRow('resource-1', '00000000-0000-4000-8000-000000000002')] })
      .mockResolvedValueOnce({ rows: [licenseRow()] })
      .mockRejectedValueOnce(new Error('audit insert failed'))
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: jest.fn() };
    const repository = new PostgresLibraryRepository({
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool);

    await expect(repository.submitContribution(validRepositoryInput())).rejects.toThrow('audit insert failed');
    expect(clientQuery).toHaveBeenNthCalledWith(6, 'ROLLBACK');
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(clientQuery.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('library_contribution_events'))).toBe(false);
  });

  it('rolls back when transactionally validated provenance is not actor-bound original authorship', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'resource-1' }] })
      .mockResolvedValueOnce({ rows: [transactionProvenanceRow(
        'resource-1',
        '00000000-0000-4000-8000-000000000002',
        undefined,
        'COMMUNITY_POST',
      )] })
      .mockResolvedValueOnce({ rows: [licenseRow()] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: jest.fn() };
    const repository = new PostgresLibraryRepository({
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool);

    await expect(repository.submitContribution(validRepositoryInput()))
      .rejects.toMatchObject({ code: 'LIBRARY_CONTRIBUTION_PROVENANCE_FORBIDDEN' });
    expect(clientQuery).toHaveBeenNthCalledWith(5, 'ROLLBACK');
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(clientQuery.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('library_resource_review_audits'))).toBe(false);
  });

  it('rolls back when final in-transaction resource hydration fails', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'resource-1' }] })
      .mockResolvedValueOnce({ rows: [transactionProvenanceRow('resource-1', '00000000-0000-4000-8000-000000000002')] })
      .mockResolvedValueOnce({ rows: [licenseRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'audit-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] })
      .mockRejectedValueOnce(new Error('hydration failed'))
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: jest.fn() };
    const repository = new PostgresLibraryRepository({
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool);

    await expect(repository.submitContribution(validRepositoryInput())).rejects.toThrow('hydration failed');
    expect(clientQuery).toHaveBeenNthCalledWith(8, 'ROLLBACK');
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(clientQuery.mock.calls[5][0]).toContain('library_contribution_events');
  });
});

function validRepositoryInput() {
  return {
    resourceId: '00000000-0000-4000-8000-000000000001',
    expectedProvenanceRevision: 1,
    contributorUserId: '00000000-0000-4000-8000-000000000002',
    resourceType: 'VOCABULARY' as const,
    termsVersion: 'library-contribution-v1' as const,
    rightsConfirmed: true as const,
    reuseConsent: true as const,
    occurredAt: new Date('2026-09-24T00:00:00.000Z'),
  };
}

function resourceRow(resourceId: string, contributorUserId: string, occurredAt: Date) {
  return {
    id: resourceId,
    resource_type: 'VOCABULARY',
    primary_language_id: '00000000-0000-4000-8000-000000000005',
    secondary_language_id: null,
    cefr_level: null,
    created_by_user_id: contributorUserId,
    visibility: 'PUBLIC',
    moderation_state: 'ACTIVE',
    review_state: 'COMMUNITY_REVIEW',
    created_at: occurredAt,
    updated_at: occurredAt,
    reviewed_by_user_id: null,
    reviewed_at: null,
    provenance_revision: '1',
    primary_language_code: 'en',
    secondary_language_code: null,
  };
}

function transactionProvenanceRow(
  resourceId: string,
  contributorUserId: string,
  occurredAt = new Date('2026-09-24T00:00:00.000Z'),
  sourceType = 'ORIGINAL_AUTHOR',
) {
  return {
    id: '00000000-0000-4000-8000-000000000006',
    resource_id: resourceId,
    source_type: sourceType,
    source_id: 'author-source',
    source_url: null,
    license_key: 'SAFE-V1',
    attribution: 'Original author',
    original_author_reference: null,
    original_contributor_user_id: contributorUserId,
    import_batch: null,
    transformation_history: [],
    source_post_id: null,
    source_response_id: null,
    source_candidate_id: null,
    source_acceptance_id: null,
    created_at: occurredAt,
    updated_at: occurredAt,
    license_display_name: 'SAFE-V1',
    license_canonical_url: 'https://licenses.example.test/safe-v1',
    license_attribution_required: true,
    license_redistribution_allowed: true,
    license_derivative_constraints: null,
    license_active: true,
    license_source_note: null,
    license_created_at: occurredAt,
    license_updated_at: occurredAt,
  };
}

function licenseRow() {
  return {
    license_key: 'SAFE-V1',
    display_name: 'SAFE-V1',
    canonical_url: 'https://licenses.example.test/safe-v1',
    attribution_required: true,
    redistribution_allowed: true,
    derivative_constraints: null,
    active: true,
    source_note: null,
  };
}
