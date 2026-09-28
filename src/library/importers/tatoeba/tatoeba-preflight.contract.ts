import {
  TATOEBA_REQUIRED_LICENSE_KEYS,
  type TatoebaImportActorRecord,
  type TatoebaImportActorSummary,
  type TatoebaImportLicenseRecord,
  type TatoebaLibraryLicenseContract,
  type TatoebaLibraryLicenseKey,
  type TatoebaLicenseContractSummary,
  type TatoebaPreflightFailureCode,
} from './tatoeba-preflight.types';

export { TATOEBA_REQUIRED_LICENSE_KEYS } from './tatoeba-preflight.types';

export const TATOEBA_LIBRARY_LICENSE_CONTRACTS: Record<
  TatoebaLibraryLicenseKey,
  TatoebaLibraryLicenseContract
> = {
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
};

export type TatoebaPreflightValidation =
  | { ok: true }
  | { ok: false; reason: TatoebaPreflightFailureCode };

export type TatoebaActorValidation =
  | { ok: true; summary: TatoebaImportActorSummary }
  | { ok: false; reason: TatoebaPreflightFailureCode; summary: TatoebaImportActorSummary };

export type TatoebaLicenseValidation =
  | { ok: true; summary: TatoebaLicenseContractSummary }
  | { ok: false; reason: TatoebaPreflightFailureCode; summary: TatoebaLicenseContractSummary };

export class TatoebaPreflightError extends Error {
  constructor(
    readonly code: TatoebaPreflightFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'TatoebaPreflightError';
  }
}

export function preflightError(
  code: TatoebaPreflightFailureCode,
  message: string,
): TatoebaPreflightError {
  return new TatoebaPreflightError(code, message);
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export function validateImportActor(
  requestedUserId: string,
  actor: TatoebaImportActorRecord | null,
): TatoebaActorValidation {
  if (!actor || actor.userId !== requestedUserId) {
    return {
      ok: false,
      reason: 'TATOEBA_IMPORT_ACTOR_NOT_FOUND',
      summary: { userId: requestedUserId, active: false, admin: false },
    };
  }

  const active = actor.status === 'ACTIVE';
  const admin = actor.roles.includes('ADMIN');
  const summary = { userId: requestedUserId, active, admin };
  if (!active) return { ok: false, reason: 'TATOEBA_IMPORT_ACTOR_INACTIVE', summary };
  if (!admin) return { ok: false, reason: 'TATOEBA_IMPORT_ACTOR_NOT_ADMIN', summary };
  return { ok: true, summary };
}

function missingLicenseSummary(): TatoebaLicenseContractSummary {
  return {
    present: false,
    active: null,
    redistributionAllowed: null,
    attributionRequired: null,
    contractMatch: false,
  };
}

function licenseSummary(license: TatoebaImportLicenseRecord): TatoebaLicenseContractSummary {
  return {
    present: true,
    active: license.active,
    redistributionAllowed: license.redistributionAllowed,
    attributionRequired: license.attributionRequired,
    contractMatch: false,
  };
}

export function validateImportLicense(
  key: TatoebaLibraryLicenseKey,
  license: TatoebaImportLicenseRecord | null,
): TatoebaLicenseValidation {
  if (!license || license.licenseKey !== key) {
    return { ok: false, reason: 'TATOEBA_LICENSE_REGISTRY_MISSING', summary: missingLicenseSummary() };
  }

  const expected = TATOEBA_LIBRARY_LICENSE_CONTRACTS[key];
  const summary = licenseSummary(license);
  if (!license.active) return { ok: false, reason: 'TATOEBA_LICENSE_REGISTRY_INACTIVE', summary };
  if (license.redistributionAllowed !== true) {
    return { ok: false, reason: 'TATOEBA_LICENSE_REGISTRY_REDISTRIBUTION_UNSAFE', summary };
  }
  if (license.attributionRequired !== expected.attributionRequired) {
    return { ok: false, reason: 'TATOEBA_LICENSE_REGISTRY_ATTRIBUTION_MISMATCH', summary };
  }
  if (license.canonicalUrl !== expected.canonicalUrl) {
    return { ok: false, reason: 'TATOEBA_LICENSE_REGISTRY_URL_MISMATCH', summary };
  }
  if (license.displayName !== expected.displayName) {
    return { ok: false, reason: 'TATOEBA_LICENSE_REGISTRY_DISPLAY_NAME_MISMATCH', summary };
  }

  return {
    ok: true,
    summary: { ...summary, contractMatch: true },
  };
}

export function requiredLicenseKeys(): readonly TatoebaLibraryLicenseKey[] {
  return TATOEBA_REQUIRED_LICENSE_KEYS;
}
