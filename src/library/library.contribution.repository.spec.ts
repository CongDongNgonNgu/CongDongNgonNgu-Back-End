import type { Pool } from 'pg';
import { PostgresLibraryRepository } from './postgres-library.repository';

describe('PostgresLibraryRepository community contribution transaction', () => {
  it('updates the resource, audit, and durable event on one transaction', async () => {
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
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [updatedRow] })
      .mockResolvedValueOnce({ rows: [{ provenance_count: 1, missing_count: 0, inactive_count: 0, redistribution_count: 0 }] })
      .mockResolvedValueOnce({ rows: [auditRow] })
      .mockResolvedValueOnce({ rows: [eventRow] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: jest.fn() };
    const poolQuery = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT\n         resource.*')) return Promise.resolve({ rows: [updatedRow] });
      if (sql.includes('library_resource_topics')) return Promise.resolve({ rows: [] });
      if (sql.includes('library_resource_provenance')) return Promise.resolve({ rows: [] });
      if (sql.includes('library_vocabularies')) {
        return Promise.resolve({ rows: [{ term: 'word', definition: 'meaning', part_of_speech: null, example_sentence: null }] });
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    });
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
    expect(clientQuery).toHaveBeenNthCalledWith(6, 'COMMIT');
    expect(clientQuery.mock.calls[1][0]).toContain("review_state = 'COMMUNITY_REVIEW'::library_review_state");
    expect(clientQuery.mock.calls[1][0]).toContain('created_by_user_id = $3::uuid');
    expect(clientQuery.mock.calls[1][0]).toContain("visibility = 'PUBLIC'::community_post_visibility");
    expect(clientQuery.mock.calls[4][0]).toContain('library_contribution_events');
    expect(clientQuery.mock.calls[4][0]).not.toContain('details');
  });

  it('rolls back the review transition and audit when the event insert fails', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'resource-1' }] })
      .mockResolvedValueOnce({ rows: [{ provenance_count: 1, missing_count: 0, inactive_count: 0, redistribution_count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'audit-1' }] })
      .mockRejectedValueOnce(new Error('event insert failed'))
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: jest.fn() };
    const repository = new PostgresLibraryRepository({
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool);

    await expect(repository.submitContribution(validRepositoryInput())).rejects.toThrow('event insert failed');
    expect(clientQuery).toHaveBeenNthCalledWith(6, 'ROLLBACK');
    expect(clientQuery.mock.calls[4][0]).toContain('library_contribution_events');
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back the resource transition when the review audit insert fails', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'resource-1' }] })
      .mockResolvedValueOnce({ rows: [{ provenance_count: 1, missing_count: 0, inactive_count: 0, redistribution_count: 0 }] })
      .mockRejectedValueOnce(new Error('audit insert failed'))
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: jest.fn() };
    const repository = new PostgresLibraryRepository({
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool);

    await expect(repository.submitContribution(validRepositoryInput())).rejects.toThrow('audit insert failed');
    expect(clientQuery).toHaveBeenNthCalledWith(5, 'ROLLBACK');
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(clientQuery.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('library_contribution_events'))).toBe(false);
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
