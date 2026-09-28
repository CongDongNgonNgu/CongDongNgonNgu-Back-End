import { describe, expect, it } from '@jest/globals';

import { runTatoebaImportPreflight } from './tatoeba-preflight.service';
import type {
  TatoebaImportActorRecord,
  TatoebaImportLicenseRecord,
  TatoebaImportPreflightRepository,
} from './tatoeba-preflight.types';

const ACTOR_ID = '00000000-0000-4000-8000-000000000001';

const actor: TatoebaImportActorRecord = {
  userId: ACTOR_ID,
  status: 'ACTIVE',
  roles: ['ADMIN', 'MEMBER'],
};

const licenses: Record<string, TatoebaImportLicenseRecord> = {
  CC_BY_2_0_FR: {
    licenseKey: 'CC_BY_2_0_FR',
    displayName: 'CC BY 2.0 France',
    canonicalUrl: 'https://creativecommons.org/licenses/by/2.0/fr/',
    attributionRequired: true,
    redistributionAllowed: true,
    active: true,
  },
  CC0_1_0: {
    licenseKey: 'CC0_1_0',
    displayName: 'CC0 1.0',
    canonicalUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    attributionRequired: false,
    redistributionAllowed: true,
    active: true,
  },
};

function repositoryFor(
  actorRecord: TatoebaImportActorRecord | null = actor,
  licenseRows: Record<string, TatoebaImportLicenseRecord | null> = licenses,
): TatoebaImportPreflightRepository {
  return {
    withReadOnlyTransaction: async (callback) => callback({
      findImportActor: async (_userId: string) => actorRecord,
      findLicense: async (key) => licenseRows[key] ?? null,
    }),
  };
}

describe('runTatoebaImportPreflight', () => {
  it('returns a privacy-safe PASS only when actor and both required licenses pass', async () => {
    const result = await runTatoebaImportPreflight({
      environment: 'TEST',
      actorUserId: ACTOR_ID,
    }, repositoryFor());

    expect(result).toEqual({
      status: 'PASS',
      environment: 'TEST',
      actor: { userId: ACTOR_ID, active: true, admin: true },
      licenses: {
        CC_BY_2_0_FR: {
          present: true,
          active: true,
          redistributionAllowed: true,
          attributionRequired: true,
          contractMatch: true,
        },
        CC0_1_0: {
          present: true,
          active: true,
          redistributionAllowed: true,
          attributionRequired: false,
          contractMatch: true,
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/email|password|sourceNote|databaseUrl/i);
  });

  it('fails closed without license registration or writes when a license is missing', async () => {
    const result = await runTatoebaImportPreflight({
      environment: 'TEST',
      actorUserId: ACTOR_ID,
    }, repositoryFor(actor, { ...licenses, CC0_1_0: null }));

    expect(result).toMatchObject({
      status: 'FAIL',
      reason: 'TATOEBA_LICENSE_REGISTRY_MISSING',
    });
  });

  it('maps unexpected repository failures to a stable sanitized database error', async () => {
    const repository: TatoebaImportPreflightRepository = {
      withReadOnlyTransaction: async () => {
        throw new Error('postgresql://secret:password@example.test/db');
      },
    };

    await expect(runTatoebaImportPreflight({
      environment: 'TEST',
      actorUserId: ACTOR_ID,
    }, repository)).rejects.toMatchObject({
      code: 'TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE',
    });
  });

  it('ignores unrelated license rows because only the two required keys are queried', async () => {
    const result = await runTatoebaImportPreflight({
      environment: 'TEST',
      actorUserId: ACTOR_ID,
    }, repositoryFor(actor, {
      ...licenses,
      UNRELATED_LICENSE: {
        licenseKey: 'UNRELATED_LICENSE',
        displayName: 'Unrelated',
        canonicalUrl: 'https://example.test/unrelated',
        attributionRequired: true,
        redistributionAllowed: false,
        active: false,
      },
    }));

    expect(result.status).toBe('PASS');
  });
});
