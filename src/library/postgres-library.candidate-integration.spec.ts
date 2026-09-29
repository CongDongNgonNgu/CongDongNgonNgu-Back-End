import type { Pool } from 'pg';
import { normalizeLibraryProvenanceInput, normalizeLibraryResourceInput } from './library.normalization';
import { PostgresLibraryRepository } from './postgres-library.repository';
import type { LibraryCandidateRecord } from '../corrections/corrections.types';
import type { LibraryCandidateIntegrationRepositoryInput } from './library.types';

describe('PostgresLibraryRepository candidate integration', () => {
  it('uses a candidate-scoped transaction and sends a coherent candidate to review', async () => {
    const candidate = phase06Candidate();
    const input = integrationInput(candidate);
    const resourceId = uuid(10);
    const date = new Date('2026-09-29T00:00:00.000Z');
    const resourceRow = resourceRowFor(candidate, resourceId, date, 'COMMUNITY_REVIEW');
    const provenanceRow = provenanceRowFor(candidate, resourceId, date);
    const auditRow = {
      id: uuid(12),
      resource_id: resourceId,
      actor_user_id: uuid(90),
      previous_state: 'DRAFT',
      new_state: 'COMMUNITY_REVIEW',
      action: 'SUBMIT',
      note: null,
      created_at: date,
    };
    const clientQuery = jest.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM community_library_candidates AS candidate')) return { rows: [sourceRow(candidate)] };
      if (sql.includes('FROM library_licenses WHERE license_key')) return { rows: [licenseRow()] };
      if (sql.includes('FROM library_resource_provenance AS provenance') && sql.includes('provenance.source_type')) return { rows: [] };
      if (sql.includes('SELECT id FROM library_resources WHERE id')) return { rows: [{ id: resourceId }] };
      if (sql.startsWith('INSERT INTO library_resources')) return { rows: [resourceRow] };
      if (sql.includes('INSERT INTO library_sentences')) return { rows: [{}] };
      if (sql.startsWith('INSERT INTO library_resource_provenance')) return { rows: [provenanceRow] };
      if (sql.startsWith('UPDATE library_resources')) return { rows: [resourceRow] };
      if (sql.includes('INSERT INTO library_resource_review_audits')) return { rows: [auditRow] };
      if (sql.includes('FROM library_resources AS resource')) return { rows: [resourceRow] };
      if (sql.includes('SELECT topic FROM library_resource_topics')) return { rows: [] };
      if (sql.includes('FROM library_resource_provenance AS provenance')) return { rows: [provenanceRow] };
      if (sql.includes('SELECT text_content, context FROM library_sentences')) {
        return { rows: [{ text_content: 'Corrected sentence', context: null }] };
      }
      throw new Error('Unexpected SQL: ' + sql);
    });
    const client = { query: clientQuery, release: jest.fn() };
    const pool = {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn(),
    };
    const repository = new PostgresLibraryRepository(pool as unknown as Pool);

    const result = await repository.integrateLibraryCandidate(input);

    expect(result).toMatchObject({
      outcome: 'CREATED',
      resource: { id: resourceId, reviewState: 'COMMUNITY_REVIEW' },
      provenance: { sourceId: candidate.id, sourceCandidateId: candidate.id },
      audit: { action: 'SUBMIT', actorUserId: uuid(90) },
    });
    expect(clientQuery).toHaveBeenCalledWith('BEGIN');
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
    expect(clientQuery).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['PHASE06_LIBRARY_CANDIDATE:' + candidate.id],
    );
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('$1::uuid'))).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('candidate.source_response_id'))).toBe(true);
    expect(clientQuery).not.toHaveBeenCalledWith('ROLLBACK');
  });

  it('rolls back all candidate integration writes when audit persistence fails', async () => {
    const candidate = phase06Candidate();
    const input = integrationInput(candidate);
    const clientQuery = jest.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM community_library_candidates AS candidate')) return { rows: [sourceRow(candidate)] };
      if (sql.includes('FROM library_licenses WHERE license_key')) return { rows: [licenseRow()] };
      if (sql.includes('FROM library_resource_provenance AS provenance') && sql.includes('provenance.source_type')) return { rows: [] };
      if (sql.startsWith('INSERT INTO library_resources')) return { rows: [resourceRowFor(candidate, uuid(10), new Date(), 'DRAFT')] };
      if (sql.includes('INSERT INTO library_sentences')) return { rows: [{}] };
      if (sql.startsWith('INSERT INTO library_resource_provenance')) return { rows: [{}] };
      if (sql.startsWith('UPDATE library_resources')) return { rows: [resourceRowFor(candidate, uuid(10), new Date(), 'COMMUNITY_REVIEW')] };
      if (sql.includes('INSERT INTO library_resource_review_audits')) throw new Error('audit write failed');
      throw new Error('Unexpected SQL: ' + sql);
    });
    const client = { query: clientQuery, release: jest.fn() };
    const pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn() };
    const repository = new PostgresLibraryRepository(pool as unknown as Pool);

    await expect(repository.integrateLibraryCandidate(input)).rejects.toThrow('audit write failed');
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});

function integrationInput(candidate: LibraryCandidateRecord): LibraryCandidateIntegrationRepositoryInput {
  return {
    candidate,
    resource: normalizeLibraryResourceInput({
      resourceType: 'SENTENCE',
      primaryLanguageCode: 'en',
      visibility: 'PUBLIC',
      details: { text: 'Corrected sentence' },
    }),
    provenance: normalizeLibraryProvenanceInput({
      sourceType: 'PHASE06_LIBRARY_CANDIDATE',
      sourceId: candidate.id,
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Phase 06 community candidate',
      originalContributorUserId: candidate.contributorUserId,
      sourcePostId: candidate.sourcePostId,
      sourceResponseId: candidate.sourceResponseId,
      sourceCandidateId: candidate.id,
      sourceAcceptanceId: candidate.acceptanceId,
    }),
    actorUserId: uuid(90),
    occurredAt: new Date('2026-09-29T00:00:00.000Z'),
  };
}

function sourceRow(candidate: LibraryCandidateRecord): Record<string, unknown> {
  return {
    id: candidate.id,
    source_post_id: candidate.sourcePostId,
    source_response_id: candidate.sourceResponseId,
    contributor_user_id: candidate.contributorUserId,
    target_language_id: uuid(20),
    target_language_code: candidate.targetLanguageCode,
    response_kind: candidate.responseKind,
    source_text: candidate.sourceText,
    corrected_text: candidate.correctedText,
    answer_text: candidate.answerText,
    explanation: candidate.explanation,
    acceptance_id: candidate.acceptanceId,
    state: candidate.state,
    parent_post_type: 'CORRECTION_REQUEST',
    parent_content: 'Correction request content',
    parent_visibility: 'PUBLIC',
    parent_moderation_state: 'ACTIVE',
    response_author_user_id: candidate.contributorUserId,
    response_parent_post_id: candidate.sourcePostId,
    response_current_kind: candidate.responseKind,
    response_corrected_text: candidate.correctedText,
    response_answer_text: candidate.answerText,
    response_explanation: candidate.explanation,
    response_moderation_state: 'ACTIVE',
    correction_original_text: candidate.sourceText,
    acceptance_row_id: candidate.acceptanceId,
    acceptance_parent_post_id: candidate.sourcePostId,
    acceptance_response_id: candidate.sourceResponseId,
    acceptance_accepted_by_user_id: candidate.acceptedByUserId,
    acceptance_accepted_at: candidate.acceptedAt,
    acceptance_revoked_at: null,
  };
}

function licenseRow(): Record<string, unknown> {
  return {
    license_key: 'COMMUNITY-V1',
    display_name: 'Community v1',
    canonical_url: 'https://licenses.example.test/community-v1',
    attribution_required: true,
    redistribution_allowed: true,
    derivative_constraints: null,
    active: true,
    source_note: null,
    created_at: '2026-09-21T00:00:00.000Z',
    updated_at: '2026-09-21T00:00:00.000Z',
  };
}

function resourceRowFor(
  candidate: LibraryCandidateRecord,
  resourceId: string,
  date: Date,
  reviewState: 'DRAFT' | 'COMMUNITY_REVIEW',
): Record<string, unknown> {
  return {
    id: resourceId,
    resource_type: 'SENTENCE',
    primary_language_id: uuid(20),
    secondary_language_id: null,
    cefr_level: null,
    created_by_user_id: candidate.contributorUserId,
    visibility: 'PUBLIC',
    moderation_state: 'ACTIVE',
    review_state: reviewState,
    created_at: date,
    updated_at: date,
    reviewed_by_user_id: null,
    reviewed_at: null,
    provenance_revision: '1',
    primary_language_code: 'en',
    secondary_language_code: null,
  };
}

function provenanceRowFor(
  candidate: LibraryCandidateRecord,
  resourceId: string,
  date: Date,
): Record<string, unknown> {
  return {
    id: uuid(11),
    resource_id: resourceId,
    source_type: 'PHASE06_LIBRARY_CANDIDATE',
    source_id: candidate.id,
    source_url: null,
    license_key: 'COMMUNITY-V1',
    attribution: 'Phase 06 community candidate',
    original_author_reference: null,
    original_contributor_user_id: candidate.contributorUserId,
    import_batch: null,
    transformation_history: '[]',
    source_post_id: candidate.sourcePostId,
    source_response_id: candidate.sourceResponseId,
    source_candidate_id: candidate.id,
    source_acceptance_id: candidate.acceptanceId,
    created_at: date,
    updated_at: date,
    license_display_name: 'Community v1',
    license_canonical_url: 'https://licenses.example.test/community-v1',
    license_attribution_required: true,
    license_redistribution_allowed: true,
    license_derivative_constraints: null,
    license_active: true,
    license_source_note: null,
    license_created_at: date,
    license_updated_at: date,
  };
}

function phase06Candidate(): LibraryCandidateRecord {
  return {
    id: uuid(4),
    sourcePostId: uuid(2),
    sourceResponseId: uuid(3),
    contributorUserId: uuid(6),
    targetLanguageCode: 'en',
    responseKind: 'CORRECTION_PROPOSAL',
    sourceText: 'Original sentence',
    correctedText: 'Corrected sentence',
    answerText: null,
    explanation: 'Reviewer explanation',
    acceptanceId: uuid(5),
    acceptedByUserId: uuid(7),
    acceptedAt: new Date('2026-09-21T00:00:00.000Z'),
    candidateCreatedByUserId: uuid(8),
    state: 'PENDING_REVIEW',
    createdAt: new Date('2026-09-21T00:00:00.000Z'),
    updatedAt: new Date('2026-09-21T00:00:00.000Z'),
    invalidatedAt: null,
    invalidationReason: null,
  };
}

function uuid(value: number): string {
  return '00000000-0000-4000-8000-' + value.toString().padStart(12, '0');
}
