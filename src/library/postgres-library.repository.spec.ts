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
    expect(clientQuery).toHaveBeenNthCalledWith(3, 'ROLLBACK');
  });
});
