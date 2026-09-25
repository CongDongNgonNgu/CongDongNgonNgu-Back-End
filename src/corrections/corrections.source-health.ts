export const PHASE06_SOURCE_HEALTH_REASONS = [
  'VALID',
  'CANDIDATE_INVALIDATED',
  'CANDIDATE_MISSING',
  'ACCEPTANCE_REVOKED_OR_REPLACED',
  'RESPONSE_INACTIVE_OR_MISSING',
  'PARENT_INACTIVE_OR_MISSING',
  'PARENT_NOT_PUBLIC',
  'SOURCE_REFERENCE_MISMATCH',
] as const;

export type Phase06SourceHealthReason = typeof PHASE06_SOURCE_HEALTH_REASONS[number];

export interface Phase06SourceReference {
  sourceId: string;
  sourcePostId: string;
  sourceResponseId: string;
  sourceCandidateId: string;
  sourceAcceptanceId: string;
}

export interface Phase06SourceHealth {
  valid: boolean;
  reason: Phase06SourceHealthReason;
}

export interface Phase06SourceHealthRow {
  candidateId: string;
  candidateState: string;
  candidateSourcePostId: string;
  candidateSourceResponseId: string;
  candidateAcceptanceId: string;
  postExists: boolean;
  postModerationState: string | null;
  postVisibility: string | null;
  responseExists: boolean;
  responseParentPostId: string | null;
  responseModerationState: string | null;
  acceptanceExists: boolean;
  acceptanceParentPostId: string | null;
  acceptanceResponseId: string | null;
  acceptanceRevokedAt: string | null;
  currentAcceptanceId: string | null;
  currentAcceptanceResponseId: string | null;
}

export function evaluatePhase06SourceHealth(
  reference: Phase06SourceReference,
  row: Phase06SourceHealthRow | null,
): Phase06SourceHealth {
  if (!row) return invalid('CANDIDATE_MISSING');
  if (row.candidateState !== 'PENDING_REVIEW') return invalid('CANDIDATE_INVALIDATED');
  if (
    row.candidateId !== reference.sourceCandidateId ||
    row.candidateSourcePostId !== reference.sourcePostId ||
    row.candidateSourceResponseId !== reference.sourceResponseId ||
    row.candidateAcceptanceId !== reference.sourceAcceptanceId ||
    reference.sourceId !== reference.sourceCandidateId
  ) {
    return invalid('SOURCE_REFERENCE_MISMATCH');
  }
  if (!row.postExists || row.postModerationState !== 'ACTIVE') {
    return invalid('PARENT_INACTIVE_OR_MISSING');
  }
  if (row.postVisibility !== 'PUBLIC') return invalid('PARENT_NOT_PUBLIC');
  if (
    !row.responseExists ||
    row.responseModerationState !== 'ACTIVE'
  ) {
    return invalid('RESPONSE_INACTIVE_OR_MISSING');
  }
  if (row.responseParentPostId !== reference.sourcePostId) {
    return invalid('SOURCE_REFERENCE_MISMATCH');
  }
  if (
    !row.acceptanceExists ||
    row.acceptanceRevokedAt !== null ||
    row.acceptanceParentPostId !== reference.sourcePostId ||
    row.acceptanceResponseId !== reference.sourceResponseId ||
    row.currentAcceptanceId !== reference.sourceAcceptanceId ||
    row.currentAcceptanceResponseId !== reference.sourceResponseId
  ) {
    return invalid('ACCEPTANCE_REVOKED_OR_REPLACED');
  }
  return { valid: true, reason: 'VALID' };
}

function invalid(reason: Phase06SourceHealthReason): Phase06SourceHealth {
  return { valid: false, reason };
}
