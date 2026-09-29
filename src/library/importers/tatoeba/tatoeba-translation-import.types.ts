import type { LibraryReviewState } from '../../library.types';
import type { TatoebaImportEnvironment } from './tatoeba-preflight.types';
import type { TatoebaPreflightDatabaseTarget } from './tatoeba-preflight.target';
import type { TatoebaErrorCode } from './tatoeba.errors';
import type { TatoebaPreflightFailureCode } from './tatoeba-preflight.types';
import type { TatoebaTranslationCandidate } from './tatoeba.types';

export const TATOEBA_TRANSLATION_IMPORT_STATEMENT_TIMEOUT_MS = 10_000;

export type TatoebaTranslationImportQuarantineReason =
  | TatoebaErrorCode
  | TatoebaPreflightFailureCode
  | 'TATOEBA_TRANSLATION_CANDIDATE_INVALID'
  | 'TATOEBA_TRANSLATION_INTEGRITY_CONFLICT'
  | 'TATOEBA_TRANSLATION_VERIFIED_CHANGE_REQUIRES_REVIEW'
  | 'TATOEBA_TRANSLATION_REJECTED_NO_REOPEN';

export interface TatoebaTranslationImportCommand {
  actorUserId: string;
  candidate: TatoebaTranslationCandidate;
}

export interface TatoebaTranslationImportCreatedResult {
  status: 'CREATED';
  durableIdentity: string;
  inputPairIdentity: string;
  resourceId: string;
  reviewState: 'COMMUNITY_REVIEW';
  durableResourceCreated: true;
}

export interface TatoebaTranslationImportNoopResult {
  status: 'NOOP';
  durableIdentity: string;
  inputPairIdentity: string;
  resourceId: string;
  reviewState: LibraryReviewState;
  durableResourceCreated: false;
}

export interface TatoebaTranslationImportReconciledResult {
  status: 'RECONCILED';
  durableIdentity: string;
  inputPairIdentity: string;
  resourceId: string;
  reviewState: 'COMMUNITY_REVIEW';
  durableResourceCreated: false;
}

export interface TatoebaTranslationImportInvalidatedResult {
  status: 'INVALIDATED';
  durableIdentity: string;
  inputPairIdentity: string;
  resourceId: string;
  reviewState: 'COMMUNITY_REVIEW';
  durableResourceCreated: false;
}

export interface TatoebaTranslationImportQuarantinedResult {
  status: 'QUARANTINED';
  durableIdentity: string | null;
  inputPairIdentity: string | null;
  reason: TatoebaTranslationImportQuarantineReason;
  durableResourceCreated: false;
}

export type TatoebaTranslationImportOutcome =
  | TatoebaTranslationImportCreatedResult
  | TatoebaTranslationImportNoopResult
  | TatoebaTranslationImportReconciledResult
  | TatoebaTranslationImportInvalidatedResult
  | TatoebaTranslationImportQuarantinedResult;

export interface TatoebaTranslationImportRepository {
  importTranslation(command: TatoebaTranslationImportCommand): Promise<TatoebaTranslationImportOutcome>;
}

export interface TatoebaTranslationImportTarget extends TatoebaPreflightDatabaseTarget {
  environment: TatoebaImportEnvironment;
}

export interface TatoebaTranslationImportRepositoryHandle {
  repository: TatoebaTranslationImportRepository;
  close(): Promise<void>;
}
