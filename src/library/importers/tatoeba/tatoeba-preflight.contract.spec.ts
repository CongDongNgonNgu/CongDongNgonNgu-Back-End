import { describe, expect, it } from '@jest/globals';

import {
  TATOEBA_LIBRARY_LICENSE_CONTRACTS,
  TATOEBA_REQUIRED_LICENSE_KEYS,
  isUuid,
  validateImportActor,
  validateImportLicense,
} from './tatoeba-preflight.contract';
import type {
  TatoebaImportActorRecord,
  TatoebaImportLicenseRecord,
} from './tatoeba-preflight.types';

const ACTOR_ID = '00000000-0000-4000-8000-000000000001';

function actor(
  status: string,
  roles: string[] = [],
): TatoebaImportActorRecord {
  return { userId: ACTOR_ID, status, roles };
}

function license(
  key: string,
  overrides: Partial<TatoebaImportLicenseRecord> = {},
): TatoebaImportLicenseRecord {
  const expected = TATOEBA_LIBRARY_LICENSE_CONTRACTS[key as keyof typeof TATOEBA_LIBRARY_LICENSE_CONTRACTS];
  return {
    licenseKey: key,
    displayName: expected.displayName,
    canonicalUrl: expected.canonicalUrl,
    attributionRequired: expected.attributionRequired,
    redistributionAllowed: true,
    active: true,
    ...overrides,
  };
}

describe('Tatoeba 08D3B1 pure preflight contracts', () => {
  it('uses the two normalized project-owned license keys and exact contracts', () => {
    expect(TATOEBA_REQUIRED_LICENSE_KEYS).toEqual(['CC_BY_2_0_FR', 'CC0_1_0']);
    expect(TATOEBA_LIBRARY_LICENSE_CONTRACTS).toEqual({
      CC_BY_2_0_FR: {
        displayName: 'CC BY 2.0 France',
        canonicalUrl: 'https://creativecommons.org/licenses/by/2.0/fr/',
        attributionRequired: true,
        redistributionAllowed: true,
      },
      CC0_1_0: {
        displayName: 'CC0 1.0',
        canonicalUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        attributionRequired: false,
        redistributionAllowed: true,
      },
    });
  });

  it('validates UUIDs before any database boundary', () => {
    expect(isUuid(ACTOR_ID)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
  });

  it.each([
    ['not found', null, 'TATOEBA_IMPORT_ACTOR_NOT_FOUND'],
    ['active member', actor('ACTIVE', ['MEMBER']), 'TATOEBA_IMPORT_ACTOR_NOT_ADMIN'],
    ['active moderator', actor('ACTIVE', ['MODERATOR']), 'TATOEBA_IMPORT_ACTOR_NOT_ADMIN'],
    ['pending admin', actor('VERIFICATION_PENDING', ['ADMIN']), 'TATOEBA_IMPORT_ACTOR_INACTIVE'],
    ['disabled admin', actor('DISABLED', ['ADMIN']), 'TATOEBA_IMPORT_ACTOR_INACTIVE'],
  ])('fails closed for %s', (_label, record, reason) => {
    expect(validateImportActor(ACTOR_ID, record as TatoebaImportActorRecord | null)).toMatchObject({
      ok: false,
      reason,
    });
  });

  it.each([
    ['active admin', actor('ACTIVE', ['ADMIN'])],
    ['active admin with member', actor('ACTIVE', ['ADMIN', 'MEMBER'])],
    ['active admin with moderator', actor('ACTIVE', ['ADMIN', 'MODERATOR'])],
  ])('accepts %s', (_label, record) => {
    expect(validateImportActor(ACTOR_ID, record)).toMatchObject({ ok: true });
  });

  it('rejects an actor row whose returned ID does not match the requested ID', () => {
    expect(validateImportActor(ACTOR_ID, {
      userId: '00000000-0000-4000-8000-000000000002',
      status: 'ACTIVE',
      roles: ['ADMIN'],
    })).toMatchObject({ ok: false, reason: 'TATOEBA_IMPORT_ACTOR_NOT_FOUND' });
  });

  it.each([
    ['missing', null, 'TATOEBA_LICENSE_REGISTRY_MISSING'],
    ['inactive', license('CC_BY_2_0_FR', { active: false }), 'TATOEBA_LICENSE_REGISTRY_INACTIVE'],
    ['redistribution false', license('CC_BY_2_0_FR', { redistributionAllowed: false }), 'TATOEBA_LICENSE_REGISTRY_REDISTRIBUTION_UNSAFE'],
    ['redistribution null', license('CC_BY_2_0_FR', { redistributionAllowed: null }), 'TATOEBA_LICENSE_REGISTRY_REDISTRIBUTION_UNSAFE'],
    ['wrong attribution', license('CC_BY_2_0_FR', { attributionRequired: false }), 'TATOEBA_LICENSE_REGISTRY_ATTRIBUTION_MISMATCH'],
    ['wrong URL', license('CC_BY_2_0_FR', { canonicalUrl: 'https://example.test/license' }), 'TATOEBA_LICENSE_REGISTRY_URL_MISMATCH'],
    ['wrong display name', license('CC_BY_2_0_FR', { displayName: 'Unrelated license' }), 'TATOEBA_LICENSE_REGISTRY_DISPLAY_NAME_MISMATCH'],
  ])('fails closed for %s license registry state', (_label, record, reason) => {
    expect(validateImportLicense('CC_BY_2_0_FR', record as TatoebaImportLicenseRecord | null)).toMatchObject({
      ok: false,
      reason,
    });
  });

  it('accepts each exact required license contract', () => {
    for (const key of TATOEBA_REQUIRED_LICENSE_KEYS) {
      expect(validateImportLicense(key, license(key))).toMatchObject({
        ok: true,
        summary: {
          present: true,
          active: true,
          redistributionAllowed: true,
          contractMatch: true,
        },
      });
    }
  });

  it('does not require or inspect derivative constraints and ignores unrelated registry rows', () => {
    expect(validateImportLicense('CC_BY_2_0_FR', license('CC_BY_2_0_FR', {
      derivativeConstraints: 'Administrator-managed note',
    }))).toMatchObject({ ok: true });
    expect(validateImportLicense('CC0_1_0', license('CC0_1_0'))).toMatchObject({ ok: true });
  });
});
