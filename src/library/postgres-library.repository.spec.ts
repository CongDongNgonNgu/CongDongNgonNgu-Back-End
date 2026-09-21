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
});
