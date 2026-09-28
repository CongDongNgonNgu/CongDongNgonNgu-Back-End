export const TATOEBA_IMPORT_TEST_ENVIRONMENT = 'TEST' as const;
export type TatoebaImportEnvironment = typeof TATOEBA_IMPORT_TEST_ENVIRONMENT;

export const TATOEBA_IMPORT_DATABASE_URL_ENV = 'TATOEBA_IMPORT_DATABASE_URL' as const;
export const TATOEBA_IMPORT_EXPECTED_DATABASE_HOST_ENV = 'TATOEBA_IMPORT_EXPECTED_DATABASE_HOST' as const;
export const TATOEBA_IMPORT_EXPECTED_DATABASE_ENV = 'TATOEBA_IMPORT_EXPECTED_DATABASE_NAME' as const;
export const TATOEBA_IMPORT_EXPECTED_DATABASE_USER_ENV = 'TATOEBA_IMPORT_EXPECTED_DATABASE_USER' as const;

export const TATOEBA_PREFLIGHT_CONNECTION_TIMEOUT_MS = 5_000;
export const TATOEBA_PREFLIGHT_STATEMENT_TIMEOUT_MS = 5_000;

export const TATOEBA_REQUIRED_LICENSE_KEYS = ['CC_BY_2_0_FR', 'CC0_1_0'] as const;
export type TatoebaLibraryLicenseKey = typeof TATOEBA_REQUIRED_LICENSE_KEYS[number];

export interface TatoebaLibraryLicenseContract {
  displayName: string;
  canonicalUrl: string;
  attributionRequired: boolean;
  redistributionAllowed: true;
}

export interface TatoebaImportActorRecord {
  userId: string;
  status: string;
  roles: string[];
}

export interface TatoebaImportLicenseRecord {
  licenseKey: string;
  displayName: string;
  canonicalUrl: string;
  attributionRequired: boolean;
  redistributionAllowed: boolean | null;
  active: boolean;
  derivativeConstraints?: string | null;
}

export interface TatoebaImportPreflightTransaction {
  findImportActor(userId: string): Promise<TatoebaImportActorRecord | null>;
  findLicense(licenseKey: TatoebaLibraryLicenseKey): Promise<TatoebaImportLicenseRecord | null>;
}

export interface TatoebaImportPreflightRepository {
  withReadOnlyTransaction<T>(
    callback: (transaction: TatoebaImportPreflightTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface TatoebaImportPreflightInput {
  environment: TatoebaImportEnvironment;
  actorUserId: string;
}

export type TatoebaPreflightFailureCode =
  | 'TATOEBA_IMPORT_ARGUMENT_INVALID'
  | 'TATOEBA_IMPORT_ACTOR_ID_INVALID'
  | 'TATOEBA_IMPORT_ENVIRONMENT_REQUIRED'
  | 'TATOEBA_IMPORT_ENVIRONMENT_INVALID'
  | 'TATOEBA_IMPORT_PRODUCTION_UNSUPPORTED'
  | 'TATOEBA_IMPORT_DATABASE_URL_REQUIRED'
  | 'TATOEBA_IMPORT_DATABASE_URL_INVALID'
  | 'TATOEBA_IMPORT_EXPECTED_HOST_REQUIRED'
  | 'TATOEBA_IMPORT_DATABASE_HOST_MISMATCH'
  | 'TATOEBA_IMPORT_EXPECTED_DATABASE_REQUIRED'
  | 'TATOEBA_IMPORT_DATABASE_NAME_MISMATCH'
  | 'TATOEBA_IMPORT_EXPECTED_DATABASE_USER_REQUIRED'
  | 'TATOEBA_IMPORT_DATABASE_USER_MISMATCH'
  | 'TATOEBA_IMPORT_REMOTE_SSL_REQUIRED'
  | 'TATOEBA_IMPORT_TEST_TARGET_UNVERIFIED'
  | 'TATOEBA_IMPORT_TEST_TARGET_MISMATCH'
  | 'TATOEBA_IMPORT_ACTOR_NOT_FOUND'
  | 'TATOEBA_IMPORT_ACTOR_INACTIVE'
  | 'TATOEBA_IMPORT_ACTOR_NOT_ADMIN'
  | 'TATOEBA_LICENSE_REGISTRY_MISSING'
  | 'TATOEBA_LICENSE_REGISTRY_INACTIVE'
  | 'TATOEBA_LICENSE_REGISTRY_REDISTRIBUTION_UNSAFE'
  | 'TATOEBA_LICENSE_REGISTRY_ATTRIBUTION_MISMATCH'
  | 'TATOEBA_LICENSE_REGISTRY_URL_MISMATCH'
  | 'TATOEBA_LICENSE_REGISTRY_DISPLAY_NAME_MISMATCH'
  | 'TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE';

export interface TatoebaImportActorSummary {
  userId: string;
  active: boolean;
  admin: boolean;
}

export interface TatoebaLicenseContractSummary {
  present: boolean;
  active: boolean | null;
  redistributionAllowed: boolean | null;
  attributionRequired: boolean | null;
  contractMatch: boolean;
}

export type TatoebaLicenseContractSummaries = Record<
  TatoebaLibraryLicenseKey,
  TatoebaLicenseContractSummary
>;

export type TatoebaImportPreflightResult =
  | {
    status: 'PASS';
    environment: TatoebaImportEnvironment;
    actor: TatoebaImportActorSummary;
    licenses: TatoebaLicenseContractSummaries;
  }
  | {
    status: 'FAIL';
    environment: TatoebaImportEnvironment;
    reason: TatoebaPreflightFailureCode;
    actor?: TatoebaImportActorSummary;
    licenses?: Partial<TatoebaLicenseContractSummaries>;
  };
