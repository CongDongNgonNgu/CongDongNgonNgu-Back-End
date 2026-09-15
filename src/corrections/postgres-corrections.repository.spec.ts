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
