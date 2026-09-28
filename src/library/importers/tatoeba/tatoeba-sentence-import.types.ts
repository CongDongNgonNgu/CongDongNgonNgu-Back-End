import type { LibraryReviewState } from '../../library.types';
import type { TatoebaImportEnvironment } from './tatoeba-preflight.types';
import type { TatoebaPreflightDatabaseTarget } from './tatoeba-preflight.target';
import type { TatoebaErrorCode } from './tatoeba.errors';
import type { TatoebaPreflightFailureCode } from './tatoeba-preflight.types';
import type { TatoebaValidatedSentenceCandidate } from './tatoeba.types';

export const TATOEBA_SENTENCE_IMPORT_LOCK_PREFIX = 'OPEN_DATASET:TATOEBA:SENTENCE:' as const;
export const TATOEBA_SENTENCE_IMPORT_STATEMENT_TIMEOUT_MS = 10_000;

export type TatoebaSentenceImportQuarantineReason =
  | TatoebaErrorCode
  | TatoebaPreflightFailureCode
  | 'TATOEBA_IMPORT_CANDIDATE_INVALID'
  | 'TATOEBA_IMPORT_INTEGRITY_CONFLICT'
  | 'TATOEBA_IMPORT_VERIFIED_CHANGE_REQUIRES_REVIEW'
  | 'TATOEBA_IMPORT_REJECTED_NO_REOPEN';

export interface TatoebaSentenceImportCommand {
  actorUserId: string;
  candidate: TatoebaValidatedSentenceCandidate;
}

export interface TatoebaSentenceImportCreatedResult {
  status: 'CREATED';
  sourceIdentity: string;
  resourceId: string;
  reviewState: 'COMMUNITY_REVIEW';
  durableResourceCreated: true;
}

export interface TatoebaSentenceImportNoopResult {
  status: 'NOOP';
  sourceIdentity: string;
  resourceId: string;
  reviewState: LibraryReviewState;
  durableResourceCreated: false;
}

export interface TatoebaSentenceImportReconciledResult {
  status: 'RECONCILED';
  sourceIdentity: string;
  resourceId: string;
  reviewState: 'COMMUNITY_REVIEW';
  durableResourceCreated: false;
}

export interface TatoebaSentenceImportInvalidatedResult {
  status: 'INVALIDATED';
  sourceIdentity: string;
  resourceId: string;
  reviewState: 'COMMUNITY_REVIEW';
  durableResourceCreated: false;
}

export interface TatoebaSentenceImportQuarantinedResult {
  status: 'QUARANTINED';
  sourceIdentity: string | null;
  reason: TatoebaSentenceImportQuarantineReason;
  durableResourceCreated: false;
}

export type TatoebaSentenceImportOutcome =
  | TatoebaSentenceImportCreatedResult
  | TatoebaSentenceImportNoopResult
  | TatoebaSentenceImportReconciledResult
  | TatoebaSentenceImportInvalidatedResult
  | TatoebaSentenceImportQuarantinedResult;

export interface TatoebaSentenceImportRepository {
  importSentence(command: TatoebaSentenceImportCommand): Promise<TatoebaSentenceImportOutcome>;
}

export interface TatoebaSentenceImportTarget extends TatoebaPreflightDatabaseTarget {
  environment: TatoebaImportEnvironment;
}

export interface TatoebaSentenceImportRepositoryHandle {
  repository: TatoebaSentenceImportRepository;
  close(): Promise<void>;
}
