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

  it('builds a parameterized multilingual public search with publication and license gates', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = new PostgresLibraryRepository({ query } as unknown as Pool);

    await expect(repository.searchPublicResources({
      filters: {
        q: '你好',
        languageCode: 'vi',
        resourceType: 'VOCABULARY',
        topic: 'daily-life',
        cefrLevel: 'A1',
      },
      cursor: {
        updatedAt: new Date('2026-09-21T00:00:00.000Z'),
        id: '00000000-0000-4000-8000-000000000001',
      },
      limit: 10,
    })).resolves.toEqual({ items: [], hasMore: false, nextBoundary: null });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("resource.visibility = 'PUBLIC'");
    expect(sql).toContain("resource.moderation_state = 'ACTIVE'");
    expect(sql).toContain("resource.review_state = 'VERIFIED'");
    expect(sql).toContain('FROM library_resource_provenance AS provenance_exists');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('license_gate.active IS NOT TRUE');
    expect(sql).toContain('redistribution_allowed IS NOT TRUE');
    expect(sql).toContain('WITH keyword_matches AS MATERIALIZED');
    expect(sql).toContain('INNER JOIN keyword_matches AS keyword_match');
    expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT 1\s+FROM keyword_matches\s+WHERE keyword_matches\.resource_id = resource\.id/s);
    expect(sql).toContain('SELECT DISTINCT resource_id');
    expect(sql).toContain(') AS keyword_candidates');
    expect(sql.match(/\bUNION ALL\b/g)).toHaveLength(10);
    expect(sql).toContain('ILIKE');
    expect(sql).toContain('turns::text ILIKE');
    expect(sql).toContain('primary_language.code = $1');
    expect(sql).toContain('secondary_language.code = $1');
    expect(sql).toContain('topic_filter.topic = $3');
    expect(sql).toContain('resource.resource_type = $2::library_resource_type');
    expect(sql).toContain('resource.cefr_level = $4::community_cefr_level');
    expect(sql).toContain('resource.updated_at < $6::timestamptz');
    expect(sql).toContain('resource.id < $7::uuid');
    expect(sql).toContain('ORDER BY resource.updated_at DESC, resource.id DESC');
    expect(sql).toContain('LIMIT $8');
    expect(sql).not.toContain('你好');
    expect(values).toEqual(expect.arrayContaining([
      'vi', 'VOCABULARY', 'daily-life', 'A1', '%你好%',
    ]));
    expect(values).toContain(11);
  });

  it('does not add keyword candidate SQL when q is absent', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = new PostgresLibraryRepository({ query } as unknown as Pool);

    await repository.searchPublicResources({
      filters: {
        q: null,
        languageCode: null,
        resourceType: null,
        topic: null,
        cefrLevel: null,
      },
      limit: 10,
    });

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('keyword_matches');
    expect(sql).not.toContain('INNER JOIN keyword_match');
  });

  it('escapes wildcard characters and backslashes in the parameterized keyword candidate query', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = new PostgresLibraryRepository({ query } as unknown as Pool);
    const userQuery = ['a%b_c', 'd'].join('\\');

    await repository.searchPublicResources({
      filters: {
        q: userQuery,
        languageCode: null,
        resourceType: null,
        topic: null,
        cefrLevel: null,
      },
      limit: 10,
    });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ESCAPE E'\\\\'");
    expect(sql).not.toContain(userQuery);
    expect(values).toEqual(['%a\\%b\\_c\\\\d%', 11]);
  });

  it('returns the cursor boundary from the ordered search rows, not hydrated records', async () => {
    const boundaryId = '00000000-0000-4000-8000-000000000001';
    const query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT resource.id, resource.updated_at')) {
        return Promise.resolve({
          rows: [
            { id: boundaryId, updated_at: new Date('2026-09-21T00:00:00.000Z') },
            { id: '00000000-0000-4000-8000-000000000002', updated_at: new Date('2026-09-20T00:00:00.000Z') },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const repository = new PostgresLibraryRepository({ query } as unknown as Pool);

    await expect(repository.searchPublicResources({
      filters: { q: null, languageCode: null, resourceType: null, topic: null, cefrLevel: null },
      limit: 1,
    })).resolves.toMatchObject({
      items: [],
      hasMore: true,
      nextBoundary: {
        updatedAt: new Date('2026-09-21T00:00:00.000Z'),
        id: boundaryId,
      },
    });
  });

  it('requires the expected provenance revision for review transitions', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'resource-1', review_state: 'COMMUNITY_REVIEW', provenance_revision: '3' }] })
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
    })).rejects.toMatchObject({ code: 'LIBRARY_REVIEW_CONFLICT' });

    expect(clientQuery.mock.calls[1][0]).toContain('FOR UPDATE');
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
      const lockedRow = {
        ...updatedRow,
        review_state: previousState,
        reviewed_by_user_id: null,
        reviewed_at: null,
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
        .mockResolvedValueOnce({ rows: [lockedRow] });
      if (action === 'VERIFY') {
        clientQuery
          .mockResolvedValueOnce({ rows: [{ source_type: 'ORIGINAL_AUTHOR', license_key: 'SAFE-V1' }] })
          .mockResolvedValueOnce({ rows: [{ license_key: 'SAFE-V1', active: true, redistribution_allowed: true }] });
      }
      clientQuery
        .mockResolvedValueOnce({ rows: [updatedRow] })
        .mockResolvedValueOnce({ rows: [auditRow] })
        .mockResolvedValueOnce({ rows: [updatedRow] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ term: 'xin chÃ o', definition: 'greeting', part_of_speech: null, example_sentence: null }] })
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

      const updateIndex = action === 'VERIFY' ? 4 : 2;
      const updateSql = clientQuery.mock.calls[updateIndex][0] as string;
      expect(updateSql).toContain('THEN $4::uuid');
      expect(updateSql).toContain('THEN $5::timestamptz');
      expect(updateSql).toContain('updated_at = $5::timestamptz');
      expect(updateSql).toContain('WHERE id = $1::uuid');
      expect(updateSql).toContain('provenance_revision = $6::bigint');

      const auditSql = clientQuery.mock.calls[updateIndex + 1][0] as string;
      expect(auditSql).toContain('VALUES ($1::uuid, $2::uuid, $3::library_review_state, $4::library_review_state, $5::library_review_action, $6, $7::timestamptz)');
      expect(clientQuery).toHaveBeenNthCalledWith(updateIndex + 7, 'COMMIT');
      expect(poolQuery).not.toHaveBeenCalled();
    },
  );

  it('rolls back the transition transaction when audit insertion fails', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: 'resource-1',
        review_state: 'COMMUNITY_REVIEW',
        provenance_revision: '4',
        moderation_state: 'ACTIVE',
        visibility: 'PUBLIC',
      }] })
      .mockResolvedValueOnce({ rows: [{ source_type: 'ORIGINAL_AUTHOR', license_key: 'SAFE-V1' }] })
      .mockResolvedValueOnce({ rows: [{ license_key: 'SAFE-V1', active: true, redistribution_allowed: true }] })
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

    expect(clientQuery).toHaveBeenNthCalledWith(7, 'ROLLBACK');
  });
});
