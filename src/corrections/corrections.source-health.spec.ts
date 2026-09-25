import {
  evaluatePhase06SourceHealth,
  type Phase06SourceHealthRow,
  type Phase06SourceReference,
} from './corrections.source-health';

describe('evaluatePhase06SourceHealth', () => {
  const reference: Phase06SourceReference = {
    sourceId: 'candidate-1',
    sourcePostId: 'post-1',
    sourceResponseId: 'response-1',
    sourceCandidateId: 'candidate-1',
    sourceAcceptanceId: 'acceptance-1',
  };

  it('accepts a coherent current Phase 06 source bundle', () => {
    expect(evaluatePhase06SourceHealth(reference, row())).toEqual({
      valid: true,
      reason: 'VALID',
    });
  });

  it.each([
    ['candidate invalidation', { candidateState: 'INVALIDATED' }, 'CANDIDATE_INVALIDATED'],
    ['candidate missing', null, 'CANDIDATE_MISSING'],
    ['acceptance revoked', { acceptanceRevokedAt: '2026-09-25T00:00:00.000Z' }, 'ACCEPTANCE_REVOKED_OR_REPLACED'],
    ['acceptance replaced', { currentAcceptanceId: 'acceptance-2' }, 'ACCEPTANCE_REVOKED_OR_REPLACED'],
    ['response hidden', { responseModerationState: 'HIDDEN' }, 'RESPONSE_INACTIVE_OR_MISSING'],
    ['response deleted', { responseModerationState: 'DELETED' }, 'RESPONSE_INACTIVE_OR_MISSING'],
    ['parent hidden', { postModerationState: 'HIDDEN' }, 'PARENT_INACTIVE_OR_MISSING'],
    ['parent deleted', { postModerationState: 'DELETED' }, 'PARENT_INACTIVE_OR_MISSING'],
    ['parent private', { postVisibility: 'PRIVATE' }, 'PARENT_NOT_PUBLIC'],
    ['source relationship mismatch', { responseParentPostId: 'post-2' }, 'SOURCE_REFERENCE_MISMATCH'],
  ] as const)('%s is invalidated with a stable reason', (_label, changes, reason) => {
    const health = evaluatePhase06SourceHealth(
      reference,
      changes === null ? null : row(changes),
    );
    expect(health).toEqual({ valid: false, reason });
  });

  it('fails closed when the stored provenance references a different candidate', () => {
    expect(evaluatePhase06SourceHealth(
      { ...reference, sourceId: 'candidate-2' },
      row(),
    )).toEqual({
      valid: false,
      reason: 'SOURCE_REFERENCE_MISMATCH',
    });
  });
});

function row(overrides: Partial<Phase06SourceHealthRow> = {}): Phase06SourceHealthRow {
  return {
    candidateId: 'candidate-1',
    candidateState: 'PENDING_REVIEW',
    candidateSourcePostId: 'post-1',
    candidateSourceResponseId: 'response-1',
    candidateAcceptanceId: 'acceptance-1',
    postExists: true,
    postModerationState: 'ACTIVE',
    postVisibility: 'PUBLIC',
    responseExists: true,
    responseParentPostId: 'post-1',
    responseModerationState: 'ACTIVE',
    acceptanceExists: true,
    acceptanceParentPostId: 'post-1',
    acceptanceResponseId: 'response-1',
    acceptanceRevokedAt: null,
    currentAcceptanceId: 'acceptance-1',
    currentAcceptanceResponseId: 'response-1',
    ...overrides,
  };
}
