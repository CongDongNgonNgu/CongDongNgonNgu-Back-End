import { describe, expect, it, jest } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';
import { CorrectionsRepositoryConflictError } from './corrections.repository';
import { PostgresCorrectionsRepository } from './postgres-corrections.repository';

describe('PostgresCorrectionsRepository', () => {
  it('creates a correction parent and extension in one transaction', async () => {
    const calls: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        calls.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
        if (sql.includes('INSERT INTO community_posts')) {
          return { rows: [postRow()] };
        }
        if (sql.includes('INSERT INTO community_correction_requests')) {
          return { rows: [correctionRow()] };
        }
        throw new Error('Unexpected SQL');
      }),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = {
      connect: jest.fn(async () => client),
    } as unknown as Pool;
    const repository = new PostgresCorrectionsRepository(pool);

    const created = await repository.createCorrectionRequest({
      authorUserId: '00000000-0000-4000-8000-000000000001',
      targetLanguageCode: 'en',
      parentContent: 'Practice sentence',
      cefrLevel: 'B1',
      topic: 'writing',
      visibility: 'PUBLIC',
      originalText: 'I has a book.',
      correctionIntent: 'GRAMMAR',
      context: null,
      createdAt: new Date('2026-09-15T08:00:00.000Z'),
    });

    expect(created.post.postType).toBe('CORRECTION_REQUEST');
    expect(created.correction.originalText).toBe('I has a book.');
    expect(calls).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO community_posts'),
      expect.stringContaining('INSERT INTO community_correction_requests'),
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back parent creation when the extension conflicts', async () => {
    const calls: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        calls.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('INSERT INTO community_posts')) {
          return { rows: [postRow()] };
        }
        const error = new Error('duplicate extension') as Error & { code: string };
        error.code = '23505';
        throw error;
      }),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = {
      connect: jest.fn(async () => client),
    } as unknown as Pool;
    const repository = new PostgresCorrectionsRepository(pool);

    await expect(repository.createCorrectionRequest({
      authorUserId: '00000000-0000-4000-8000-000000000001',
      targetLanguageCode: 'en',
      parentContent: 'Practice sentence',
      cefrLevel: null,
      topic: null,
      visibility: 'PUBLIC',
      originalText: 'I has a book.',
      correctionIntent: 'GRAMMAR',
      context: null,
      createdAt: new Date(),
    })).rejects.toBeInstanceOf(CorrectionsRepositoryConflictError);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('looks up only a pending candidate with active coherent source joins', async () => {
    const query = jest.fn(async (..._args: unknown[]) => ({ rows: [candidateRow()] }));
    const repository = new PostgresCorrectionsRepository({ query } as unknown as Pool);

    await expect(repository.findLibraryCandidateById(candidateRow().id)).resolves.toMatchObject({
      id: candidateRow().id,
      sourcePostId: candidateRow().source_post_id,
      sourceResponseId: candidateRow().source_response_id,
      acceptanceId: candidateRow().acceptance_id,
      state: 'PENDING_REVIEW',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('candidate.state = \'PENDING_REVIEW\'::phase06_library_candidate_state'),
      [candidateRow().id],
    );
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('acceptance.parent_post_id = candidate.source_post_id');
    expect(sql).toContain('acceptance.response_id = candidate.source_response_id');
  });

  it('preserves millisecond precision when mapping pg Date values for a candidate', async () => {
    const timestamp = new Date('2026-09-16T05:49:31.627Z');
    const row = {
      ...candidateRow(),
      accepted_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const query = jest.fn(async (..._args: unknown[]) => ({ rows: [row] }));
    const repository = new PostgresCorrectionsRepository({ query } as unknown as Pool);

    const candidate = await repository.findLibraryCandidateById(row.id);

    expect(candidate?.acceptedAt.toISOString()).toBe('2026-09-16T05:49:31.627Z');
    expect(candidate?.createdAt.toISOString()).toBe('2026-09-16T05:49:31.627Z');
    expect(candidate?.updatedAt.toISOString()).toBe('2026-09-16T05:49:31.627Z');
    expect(candidate?.invalidatedAt).toBeNull();
  });

  it('maps an ISO timestamp string without losing milliseconds', async () => {
    const row = {
      ...candidateRow(),
      accepted_at: '2026-09-16T05:49:31.627Z',
    };
    const query = jest.fn(async (..._args: unknown[]) => ({ rows: [row] }));
    const repository = new PostgresCorrectionsRepository({ query } as unknown as Pool);

    const candidate = await repository.findLibraryCandidateById(row.id);

    expect(candidate?.acceptedAt.toISOString()).toBe('2026-09-16T05:49:31.627Z');
  });

  it('normalizes an explicit offset timestamp to canonical UTC', async () => {
    const row = {
      ...candidateRow(),
      accepted_at: '2026-09-16T12:49:31.627+07:00',
    };
    const query = jest.fn(async (..._args: unknown[]) => ({ rows: [row] }));
    const repository = new PostgresCorrectionsRepository({ query } as unknown as Pool);

    const candidate = await repository.findLibraryCandidateById(row.id);

    expect(candidate?.acceptedAt.toISOString()).toBe('2026-09-16T05:49:31.627Z');
  });

  it('maps explicit offset timestamps independently of process timezone', async () => {
    const originalTimezone = process.env.TZ;
    try {
      for (const timezone of ['UTC', 'America/New_York']) {
        process.env.TZ = timezone;
        const row = {
          ...candidateRow(),
          accepted_at: '2026-09-16T12:49:31.627+07:00',
        };
        const query = jest.fn(async (..._args: unknown[]) => ({ rows: [row] }));
        const repository = new PostgresCorrectionsRepository({ query } as unknown as Pool);

        const candidate = await repository.findLibraryCandidateById(row.id);

        expect(candidate?.acceptedAt.toISOString()).toBe('2026-09-16T05:49:31.627Z');
      }
    } finally {
      if (originalTimezone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimezone;
      }
    }
  });

  it.each([
    ['timezone-less milliseconds', '2026-09-16T05:49:31.627'],
    ['timezone-less seconds', '2026-09-16T05:49:31'],
    ['locale-like', 'Sep 16 2026 05:49:31'],
    ['ambiguous numeric date', '09/16/2026 05:49:31'],
    ['invalid value', 'not-a-date'],
    ['invalid month', '2026-13-16T05:49:31.627Z'],
    ['invalid day', '2026-02-30T05:49:31.627Z'],
    ['invalid time', '2026-09-16T25:49:31.627Z'],
    ['malformed offset', '2026-09-16T05:49:31.627+07'],
    ['out-of-range offset', '2026-09-16T05:49:31.627+24:00'],
  ])('fails closed for %s timestamp strings', async (_caseName, acceptedAt) => {
    const row = {
      ...candidateRow(),
      accepted_at: acceptedAt,
    };
    const query = jest.fn(async (..._args: unknown[]) => ({ rows: [row] }));
    const repository = new PostgresCorrectionsRepository({ query } as unknown as Pool);

    await expect(repository.findLibraryCandidateById(row.id))
      .rejects.toMatchObject({
        name: 'CorrectionsRepositoryConflictError',
        message: 'Invalid accepted_at timestamp',
      });
  });

  it('fails closed for an unsupported non-Date timestamp value', async () => {
    const row = {
      ...candidateRow(),
      accepted_at: 1726465771627,
    };
    const query = jest.fn(async (..._args: unknown[]) => ({ rows: [row] }));
    const repository = new PostgresCorrectionsRepository({ query } as unknown as Pool);

    await expect(repository.findLibraryCandidateById(row.id))
      .rejects.toMatchObject({
        name: 'CorrectionsRepositoryConflictError',
        message: 'Invalid accepted_at timestamp',
      });
  });

  it('fails closed for an invalid candidate timestamp', async () => {
    const row = {
      ...candidateRow(),
      accepted_at: new Date(Number.NaN),
    };
    const query = jest.fn(async (..._args: unknown[]) => ({ rows: [row] }));
    const repository = new PostgresCorrectionsRepository({ query } as unknown as Pool);

    await expect(repository.findLibraryCandidateById(row.id))
      .rejects.toBeInstanceOf(CorrectionsRepositoryConflictError);
  });

  it('evaluates current source health without applying the pending-only read filter', async () => {
    const query = jest.fn(async (..._args: unknown[]) => ({ rows: [{
      candidate_id: candidateRow().id,
      candidate_state: 'INVALIDATED',
      candidate_source_post_id: candidateRow().source_post_id,
      candidate_source_response_id: candidateRow().source_response_id,
      candidate_acceptance_id: candidateRow().acceptance_id,
      post_id: candidateRow().source_post_id,
      post_moderation_state: 'ACTIVE',
      post_visibility: 'PUBLIC',
      response_id: candidateRow().source_response_id,
      response_parent_post_id: candidateRow().source_post_id,
      response_moderation_state: 'ACTIVE',
      acceptance_id: candidateRow().acceptance_id,
      acceptance_parent_post_id: candidateRow().source_post_id,
      acceptance_response_id: candidateRow().source_response_id,
      acceptance_revoked_at: null,
      current_acceptance_id: candidateRow().acceptance_id,
      current_acceptance_response_id: candidateRow().source_response_id,
    }] }));
    const repository = new PostgresCorrectionsRepository({ query } as unknown as Pool);

    await expect(repository.inspectLibraryCandidateSource({
      sourceId: candidateRow().id,
      sourcePostId: candidateRow().source_post_id,
      sourceResponseId: candidateRow().source_response_id,
      sourceCandidateId: candidateRow().id,
      sourceAcceptanceId: candidateRow().acceptance_id,
    })).resolves.toEqual({
      valid: false,
      reason: 'CANDIDATE_INVALIDATED',
    });
    expect(String(query.mock.calls[0]?.[0])).toContain('LEFT JOIN community_posts');
    expect(String(query.mock.calls[0]?.[0])).not.toContain('candidate.state =');
  });
});

function postRow() {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    author_user_id: '00000000-0000-4000-8000-000000000001',
    target_language_code: 'en',
    post_type: 'CORRECTION_REQUEST',
    content: 'Practice sentence',
    cefr_level: 'B1',
    topic: 'writing',
    visibility: 'PUBLIC',
    moderation_state: 'ACTIVE',
    created_at: '2026-09-15T08:00:00.000Z',
    updated_at: '2026-09-15T08:00:00.000Z',
    edited_at: null,
    deleted_at: null,
    deleted_by_user_id: null,
  };
}

function correctionRow() {
  return {
    post_id: '00000000-0000-4000-8000-000000000010',
    original_text: 'I has a book.',
    correction_intent: 'GRAMMAR',
    context: null,
    created_at: '2026-09-15T08:00:00.000Z',
    updated_at: '2026-09-15T08:00:00.000Z',
  };
}

function candidateRow() {
  return {
    id: '00000000-0000-4000-8000-000000000020',
    source_post_id: '00000000-0000-4000-8000-000000000010',
    source_response_id: '00000000-0000-4000-8000-000000000011',
    contributor_user_id: '00000000-0000-4000-8000-000000000001',
    target_language_code: 'en',
    response_kind: 'CORRECTION_PROPOSAL',
    source_text: 'I has a book.',
    corrected_text: 'I have a book.',
    answer_text: null,
    explanation: 'Subject-verb agreement.',
    acceptance_id: '00000000-0000-4000-8000-000000000012',
    accepted_by_user_id: '00000000-0000-4000-8000-000000000003',
    accepted_at: '2026-09-15T08:00:00.000Z',
    candidate_created_by_user_id: '00000000-0000-4000-8000-000000000004',
    state: 'PENDING_REVIEW',
    created_at: '2026-09-15T08:00:00.000Z',
    updated_at: '2026-09-15T08:00:00.000Z',
    invalidated_at: null,
    invalidation_reason: null,
  };
}
