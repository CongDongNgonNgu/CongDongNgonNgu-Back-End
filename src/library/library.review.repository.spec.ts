import type { Pool } from 'pg';
import { PostgresLibraryRepository } from './postgres-library.repository';

describe('PostgresLibraryRepository reviewer transactions', () => {
  it('uses the bounded pending-review filters and stable ascending queue order', async () => {
    const resourceId = uuid(60);
    const updatedAt = new Date('2026-09-24T00:00:00.000Z');
    const hydratedRow = resourceRow(resourceId, 'COMMUNITY_REVIEW', updatedAt);
    const poolQuery = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('ORDER BY resource.updated_at ASC, resource.id ASC')) {
        return Promise.resolve({
          rows: [
            {
              id: resourceId,
              updated_at: updatedAt,
              cursor_updated_at_micros: '1790208000000123',
            },
            {
              id: uuid(61),
              updated_at: new Date('2026-09-24T00:01:00.000Z'),
              cursor_updated_at_micros: '1790208060000456',
            },
          ],
        });
      }
      if (sql.includes('resource.*')) return Promise.resolve({ rows: [hydratedRow] });
      if (sql.includes('library_resource_topics')) return Promise.resolve({ rows: [] });
      if (sql.includes('library_resource_provenance')) return Promise.resolve({ rows: [] });
      if (sql.includes('library_vocabularies')) return Promise.resolve({ rows: [vocabularyRow()] });
      throw new Error(`Unexpected queue query: ${sql}`);
    });
    const repository = new PostgresLibraryRepository({ query: poolQuery } as unknown as Pool);

    const page = await repository.listReviewQueue({
      filters: { q: 'word', languageCode: 'en', resourceType: 'VOCABULARY' },
      cursor: {
        updatedAtMicros: '1790207999999999',
        id: uuid(59),
      },
      limit: 1,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe(resourceId);
    expect(page.hasMore).toBe(true);
    expect(page.nextBoundary).toMatchObject({
      id: resourceId,
      updatedAtMicros: '1790208000000123',
    });
    expect(poolQuery.mock.calls[0][0]).toContain("review_state = 'COMMUNITY_REVIEW'::library_review_state");
    expect(poolQuery.mock.calls[0][0]).toContain('ORDER BY resource.updated_at ASC, resource.id ASC');
    expect(poolQuery.mock.calls[0][0]).toContain('primary_language.code');
    expect(poolQuery.mock.calls[0][0]).toContain('library_vocabularies');
    expect(poolQuery.mock.calls[0][0]).toContain("INTERVAL '1 microsecond'");
    expect(poolQuery.mock.calls[0][1]).toContain('1790207999999999');
  });

  it('locks verification eligibility and hydrates before commit', async () => {
    const resourceId = uuid(1);
    const reviewerId = uuid(2);
    const occurredAt = new Date('2026-09-24T00:00:00.000Z');
    const lockedRow = resourceRow(resourceId, 'COMMUNITY_REVIEW', occurredAt);
    const updatedRow = {
      ...lockedRow,
      review_state: 'VERIFIED',
      reviewed_by_user_id: reviewerId,
      reviewed_at: occurredAt,
    };
    const auditRow = {
      id: uuid(3),
      resource_id: resourceId,
      actor_user_id: reviewerId,
      previous_state: 'COMMUNITY_REVIEW',
      new_state: 'VERIFIED',
      action: 'VERIFY',
      note: null,
      created_at: occurredAt,
    };
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [lockedRow] })
      .mockResolvedValueOnce({ rows: [{ source_type: 'ORIGINAL_AUTHOR', license_key: 'SAFE-V1' }] })
      .mockResolvedValueOnce({ rows: [{ license_key: 'SAFE-V1', active: true, redistribution_allowed: true }] })
      .mockResolvedValueOnce({ rows: [updatedRow] })
      .mockResolvedValueOnce({ rows: [auditRow] })
      .mockResolvedValueOnce({ rows: [updatedRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [provenanceRow(resourceId, occurredAt)] })
      .mockResolvedValueOnce({ rows: [vocabularyRow()] })
      .mockResolvedValueOnce({ rows: [] });
    const poolQuery = jest.fn();
    const client = { query: clientQuery, release: jest.fn() };
    const repository = new PostgresLibraryRepository({
      query: poolQuery,
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool);

    const result = await repository.transitionReview({
      resourceId,
      expectedPreviousState: 'COMMUNITY_REVIEW',
      expectedProvenanceRevision: 1,
      nextState: 'VERIFIED',
      action: 'VERIFY',
      actorUserId: reviewerId,
      note: null,
      occurredAt,
    });

    expect(result).toMatchObject({
      resource: { id: resourceId, reviewState: 'VERIFIED' },
      audit: { id: auditRow.id, action: 'VERIFY' },
    });
    expect(clientQuery.mock.calls[1][0]).toContain('FOR UPDATE');
    expect(clientQuery.mock.calls[2][0]).toContain('library_resource_provenance');
    expect(clientQuery.mock.calls[2][0]).toContain('FOR SHARE');
    expect(clientQuery.mock.calls[3][0]).toContain('library_licenses');
    expect(clientQuery.mock.calls[3][0]).toContain('FOR SHARE');
    expect(clientQuery.mock.calls[4][0]).toContain('UPDATE library_resources');
    expect(clientQuery.mock.calls[5][0]).toContain('library_resource_review_audits');
    expect(clientQuery.mock.calls[6][0]).toContain('resource.*');
    expect(clientQuery).toHaveBeenNthCalledWith(11, 'COMMIT');
    expect(clientQuery.mock.calls.slice(11)).toHaveLength(0);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('rejects atomically with a required note and hydrates before commit', async () => {
    const resourceId = uuid(10);
    const reviewerId = uuid(11);
    const occurredAt = new Date('2026-09-24T00:00:00.000Z');
    const lockedRow = resourceRow(resourceId, 'COMMUNITY_REVIEW', occurredAt);
    const updatedRow = {
      ...lockedRow,
      review_state: 'REJECTED',
      reviewed_by_user_id: reviewerId,
      reviewed_at: occurredAt,
    };
    const auditRow = {
      id: uuid(12),
      resource_id: resourceId,
      actor_user_id: reviewerId,
      previous_state: 'COMMUNITY_REVIEW',
      new_state: 'REJECTED',
      action: 'REJECT',
      note: 'Needs correction',
      created_at: occurredAt,
    };
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [lockedRow] })
      .mockResolvedValueOnce({ rows: [updatedRow] })
      .mockResolvedValueOnce({ rows: [auditRow] })
      .mockResolvedValueOnce({ rows: [updatedRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [provenanceRow(resourceId, occurredAt)] })
      .mockResolvedValueOnce({ rows: [vocabularyRow()] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: jest.fn() };
    const repository = new PostgresLibraryRepository({
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool);

    const result = await repository.transitionReview({
      resourceId,
      expectedPreviousState: 'COMMUNITY_REVIEW',
      expectedProvenanceRevision: 1,
      nextState: 'REJECTED',
      action: 'REJECT',
      actorUserId: reviewerId,
      note: 'Needs correction',
      occurredAt,
    });

    expect(result.audit.note).toBe('Needs correction');
    expect(clientQuery).toHaveBeenNthCalledWith(9, 'COMMIT');
    expect(clientQuery.mock.calls.some(([sql]) => (
      String(sql).includes('library_licenses') && String(sql).includes('FOR SHARE')
    ))).toBe(false);
  });

  it('rolls back when verification license eligibility fails', async () => {
    const resourceId = uuid(20);
    const occurredAt = new Date('2026-09-24T00:00:00.000Z');
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [resourceRow(resourceId, 'COMMUNITY_REVIEW', occurredAt)] })
      .mockResolvedValueOnce({ rows: [{ source_type: 'ORIGINAL_AUTHOR', license_key: 'UNSAFE-V1' }] })
      .mockResolvedValueOnce({ rows: [{ license_key: 'UNSAFE-V1', active: true, redistribution_allowed: false }] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: jest.fn() };
    const repository = new PostgresLibraryRepository({
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool);

    await expect(repository.transitionReview(reviewInput(resourceId, 'VERIFY')))
      .rejects.toMatchObject({ code: 'LIBRARY_LICENSE_REDISTRIBUTION_REQUIRED' });
    expect(clientQuery).toHaveBeenNthCalledWith(5, 'ROLLBACK');
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE library_resources'))).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('library_resource_review_audits'))).toBe(false);
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it.each([
    ['missing', [], 'LIBRARY_LICENSE_UNKNOWN'],
    ['inactive', [{ license_key: 'STATE-V1', active: false, redistribution_allowed: true }], 'LIBRARY_LICENSE_DISABLED'],
    ['redistribution false', [{ license_key: 'STATE-V1', active: true, redistribution_allowed: false }], 'LIBRARY_LICENSE_REDISTRIBUTION_REQUIRED'],
    ['redistribution null', [{ license_key: 'STATE-V1', active: true, redistribution_allowed: null }], 'LIBRARY_LICENSE_REDISTRIBUTION_REQUIRED'],
  ])('fails closed for %s current license state', async (_label, licenseRows, code) => {
    const resourceId = uuid(70 + String(code).length);
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [resourceRow(resourceId, 'COMMUNITY_REVIEW', new Date())] })
      .mockResolvedValueOnce({ rows: [{ source_type: 'ORIGINAL_AUTHOR', license_key: 'STATE-V1' }] })
      .mockResolvedValueOnce({ rows: licenseRows })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: jest.fn() };
    const repository = new PostgresLibraryRepository({
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool);

    await expect(repository.transitionReview(reviewInput(resourceId, 'VERIFY')))
      .rejects.toMatchObject({ code });
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE library_resources'))).toBe(false);
  });

  it('rolls back when audit insertion fails after the locked update', async () => {
    const resourceId = uuid(30);
    const occurredAt = new Date('2026-09-24T00:00:00.000Z');
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [resourceRow(resourceId, 'COMMUNITY_REVIEW', occurredAt)] })
      .mockResolvedValueOnce({ rows: [{ id: resourceId }] })
      .mockRejectedValueOnce(new Error('audit insert failed'))
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: jest.fn() };
    const repository = new PostgresLibraryRepository({
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool);

    await expect(repository.transitionReview(reviewInput(resourceId, 'REJECT', 'Needs correction')))
      .rejects.toThrow('audit insert failed');
    expect(clientQuery).toHaveBeenNthCalledWith(5, 'ROLLBACK');
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back when final hydration fails after the audit insert', async () => {
    const resourceId = uuid(40);
    const occurredAt = new Date('2026-09-24T00:00:00.000Z');
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [resourceRow(resourceId, 'COMMUNITY_REVIEW', occurredAt)] })
      .mockResolvedValueOnce({ rows: [{ source_type: 'ORIGINAL_AUTHOR', license_key: 'SAFE-V1' }] })
      .mockResolvedValueOnce({ rows: [{ license_key: 'SAFE-V1', active: true, redistribution_allowed: true }] })
      .mockResolvedValueOnce({ rows: [resourceRow(resourceId, 'VERIFIED', occurredAt)] })
      .mockResolvedValueOnce({ rows: [{ id: uuid(41), resource_id: resourceId, actor_user_id: uuid(42), previous_state: 'COMMUNITY_REVIEW', new_state: 'VERIFIED', action: 'VERIFY', note: null, created_at: occurredAt }] })
      .mockRejectedValueOnce(new Error('hydration failed'))
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: jest.fn() };
    const repository = new PostgresLibraryRepository({
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool);

    await expect(repository.transitionReview(reviewInput(resourceId, 'VERIFY')))
      .rejects.toThrow('hydration failed');
    expect(clientQuery).toHaveBeenNthCalledWith(8, 'ROLLBACK');
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('returns a deterministic conflict after the resource lock observes a stale boundary', async () => {
    const resourceId = uuid(50);
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [resourceRow(resourceId, 'VERIFIED', new Date())] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: jest.fn() };
    const repository = new PostgresLibraryRepository({
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool);

    await expect(repository.transitionReview(reviewInput(resourceId, 'VERIFY')))
      .rejects.toMatchObject({ code: 'LIBRARY_REVIEW_CONFLICT' });
    expect(clientQuery).toHaveBeenNthCalledWith(3, 'ROLLBACK');
  });
});

function reviewInput(
  resourceId: string,
  action: 'VERIFY' | 'REJECT',
  note: string | null = null,
) {
  return {
    resourceId,
    expectedPreviousState: 'COMMUNITY_REVIEW' as const,
    expectedProvenanceRevision: 1,
    nextState: action === 'VERIFY' ? 'VERIFIED' as const : 'REJECTED' as const,
    action,
    actorUserId: uuid(90),
    note,
    occurredAt: new Date('2026-09-24T00:00:00.000Z'),
  };
}

function resourceRow(
  resourceId: string,
  reviewState: string,
  occurredAt: Date,
) {
  return {
    id: resourceId,
    resource_type: 'VOCABULARY',
    primary_language_id: uuid(91),
    secondary_language_id: null,
    cefr_level: null,
    created_by_user_id: uuid(92),
    visibility: 'PUBLIC',
    moderation_state: 'ACTIVE',
    review_state: reviewState,
    created_at: occurredAt,
    updated_at: occurredAt,
    reviewed_by_user_id: null,
    reviewed_at: null,
    provenance_revision: '1',
    primary_language_code: 'en',
    secondary_language_code: null,
  };
}

function provenanceRow(resourceId: string, occurredAt: Date) {
  return {
    id: uuid(93),
    resource_id: resourceId,
    source_type: 'ORIGINAL_AUTHOR',
    source_id: 'author-source',
    source_url: null,
    license_key: 'SAFE-V1',
    attribution: 'Original author',
    original_author_reference: null,
    original_contributor_user_id: uuid(92),
    import_batch: null,
    transformation_history: [],
    source_post_id: null,
    source_response_id: null,
    source_candidate_id: null,
    source_acceptance_id: null,
    created_at: occurredAt,
    updated_at: occurredAt,
    license_display_name: 'Safe license',
    license_canonical_url: 'https://licenses.example.test/safe-v1',
    license_attribution_required: true,
    license_redistribution_allowed: true,
    license_derivative_constraints: null,
    license_active: true,
    license_source_note: 'private note',
    license_created_at: occurredAt,
    license_updated_at: occurredAt,
  };
}

function vocabularyRow() {
  return {
    term: 'word',
    definition: 'meaning',
    part_of_speech: null,
    example_sentence: null,
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}
