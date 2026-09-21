import type { Pool } from 'pg';
import { PostgresLibraryRepository } from './postgres-library.repository';

describe('PostgresLibraryRepository', () => {
  it('looks up license keys with a parameterized query and maps nullable terms', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{
        license_key: 'COMMUNITY-V1',
        display_name: 'Community v1',
        canonical_url: 'https://licenses.example.test/community-v1',
        attribution_required: true,
        redistribution_allowed: null,
        derivative_constraints: null,
        active: true,
        source_note: 'Recorded source terms',
        created_at: '2026-09-21T00:00:00.000Z',
        updated_at: '2026-09-21T00:00:00.000Z',
      }],
    });
    const repository = new PostgresLibraryRepository({ query } as unknown as Pool);

    await expect(repository.findLicense('COMMUNITY-V1')).resolves.toMatchObject({
      licenseKey: 'COMMUNITY-V1',
      redistributionAllowed: null,
      active: true,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE license_key = $1'),
      ['COMMUNITY-V1'],
    );
  });

  it('requires the expected provenance revision for review transitions', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [] });
    const client = {
      query: clientQuery,
      release: jest.fn(),
    };
    const pool = {
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(client),
    };
    const repository = new PostgresLibraryRepository(pool as unknown as Pool);

    await expect(repository.transitionReview({
      resourceId: '00000000-0000-4000-8000-000000000001',
      expectedPreviousState: 'COMMUNITY_REVIEW',
      expectedProvenanceRevision: 4,
      nextState: 'VERIFIED',
      action: 'VERIFY',
      actorUserId: '00000000-0000-4000-8000-000000000002',
      note: null,
      occurredAt: new Date('2026-09-21T00:00:00.000Z'),
    })).rejects.toMatchObject({ code: 'LIBRARY_REVIEW_CONFLICT' });

    expect(clientQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('provenance_revision = $6'),
      expect.arrayContaining([4]),
    );
    const updateSql = clientQuery.mock.calls[1][0] as string;
    expect(updateSql).toContain('THEN $4::uuid');
    expect(updateSql).toContain('THEN $5::timestamptz');
    expect(updateSql).toContain('updated_at = $5::timestamptz');
    expect(updateSql).toContain('WHERE id = $1::uuid');
    expect(updateSql).toContain('provenance_revision = $6::bigint');
    expect(clientQuery).toHaveBeenNthCalledWith(3, 'ROLLBACK');
  });

  it.each([
    {
      nextState: 'VERIFIED' as const,
      action: 'VERIFY' as const,
      previousState: 'COMMUNITY_REVIEW' as const,
      note: null,
      reviewedByUserId: '00000000-0000-4000-8000-000000000002',
      reviewedAt: new Date('2026-09-21T00:00:00.000Z'),
    },
    {
      nextState: 'REJECTED' as const,
      action: 'REJECT' as const,
      previousState: 'COMMUNITY_REVIEW' as const,
      note: 'Needs correction',
      reviewedByUserId: '00000000-0000-4000-8000-000000000002',
      reviewedAt: new Date('2026-09-21T00:00:00.000Z'),
    },
    {
      nextState: 'DRAFT' as const,
      action: 'REOPEN' as const,
      previousState: 'REJECTED' as const,
      note: 'Reopen for correction',
      reviewedByUserId: null,
      reviewedAt: null,
    },
  ])(
    '$nextState maps reviewed metadata and audit typing correctly',
    async ({ nextState, action, previousState, note, reviewedByUserId, reviewedAt }) => {
      const resourceId = '00000000-0000-4000-8000-000000000001';
      const actorUserId = '00000000-0000-4000-8000-000000000002';
      const occurredAt = new Date('2026-09-21T00:00:00.000Z');
      const updatedRow = {
        id: resourceId,
        resource_type: 'VOCABULARY',
        primary_language_id: '00000000-0000-4000-8000-000000000003',
        secondary_language_id: null,
        cefr_level: null,
        created_by_user_id: '00000000-0000-4000-8000-000000000004',
        visibility: 'PRIVATE',
        moderation_state: 'ACTIVE',
        review_state: nextState,
        created_at: occurredAt,
        updated_at: occurredAt,
        reviewed_by_user_id: reviewedByUserId,
        reviewed_at: reviewedAt,
        provenance_revision: '4',
        primary_language_code: 'vi',
        secondary_language_code: null,
      };
      const auditRow = {
        id: '00000000-0000-4000-8000-000000000005',
        resource_id: resourceId,
        actor_user_id: actorUserId,
        previous_state: previousState,
        new_state: nextState,
        action,
        note,
        created_at: occurredAt,
      };
      const clientQuery = jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [updatedRow] })
        .mockResolvedValueOnce({ rows: [auditRow] })
        .mockResolvedValueOnce({ rows: [] });
      const client = {
        query: clientQuery,
        release: jest.fn(),
      };
      const poolQuery = jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT\n         resource.*')) return Promise.resolve({ rows: [updatedRow] });
        if (sql.includes('library_resource_topics')) return Promise.resolve({ rows: [] });
        if (sql.includes('library_resource_provenance')) return Promise.resolve({ rows: [] });
        if (sql.includes('library_vocabularies')) {
          return Promise.resolve({ rows: [{ term: 'xin chào', definition: 'greeting', part_of_speech: null, example_sentence: null }] });
        }
        throw new Error(`Unexpected pool query: ${sql}`);
      });
      const pool = {
        query: poolQuery,
        connect: jest.fn().mockResolvedValue(client),
      };
      const repository = new PostgresLibraryRepository(pool as unknown as Pool);

      const result = await repository.transitionReview({
        resourceId,
        expectedPreviousState: previousState,
        expectedProvenanceRevision: 4,
        nextState,
        action,
        actorUserId,
        note,
        occurredAt,
      });

      expect(result.resource.reviewedByUserId).toBe(reviewedByUserId);
      expect(result.resource.reviewedAt?.toISOString() ?? null).toBe(reviewedAt?.toISOString() ?? null);
      expect(result.audit.action).toBe(action);
      expect(result.audit.note).toBe(note);

      const updateSql = clientQuery.mock.calls[1][0] as string;
      expect(updateSql).toContain('THEN $4::uuid');
      expect(updateSql).toContain('THEN $5::timestamptz');
      expect(updateSql).toContain('updated_at = $5::timestamptz');
      expect(updateSql).toContain('WHERE id = $1::uuid');
      expect(updateSql).toContain('provenance_revision = $6::bigint');

      const auditSql = clientQuery.mock.calls[2][0] as string;
      expect(auditSql).toContain('VALUES ($1::uuid, $2::uuid, $3::library_review_state, $4::library_review_state, $5::library_review_action, $6, $7::timestamptz)');
      expect(clientQuery).toHaveBeenNthCalledWith(4, 'COMMIT');
    },
  );

  it('rolls back the transition transaction when audit insertion fails', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'resource-1' }] })
      .mockRejectedValueOnce(new Error('audit insert failed'))
      .mockResolvedValueOnce({ rows: [] });
    const client = {
      query: clientQuery,
      release: jest.fn(),
    };
    const pool = {
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(client),
    };
    const repository = new PostgresLibraryRepository(pool as unknown as Pool);

    await expect(repository.transitionReview({
      resourceId: '00000000-0000-4000-8000-000000000001',
      expectedPreviousState: 'COMMUNITY_REVIEW',
      expectedProvenanceRevision: 4,
      nextState: 'VERIFIED',
      action: 'VERIFY',
      actorUserId: '00000000-0000-4000-8000-000000000002',
      note: null,
      occurredAt: new Date('2026-09-21T00:00:00.000Z'),
    })).rejects.toThrow('audit insert failed');

    expect(clientQuery).toHaveBeenNthCalledWith(4, 'ROLLBACK');
  });
});
