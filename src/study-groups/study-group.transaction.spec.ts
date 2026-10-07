import { describe, expect, it } from '@jest/globals';
import type { Pool } from 'pg';
import { transaction } from './study-group.store';

describe('study group transaction contract', () => {
  it('selects READ COMMITTED explicitly before reads even if database defaults differ', async () => {
    const commands: string[] = [];
    const client = {
      query: async (sql: string) => { commands.push(sql); return {}; },
      release: () => commands.push('RELEASE'),
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const result = await transaction(pool, async connection => {
      await connection.query('SELECT current persisted ACL');
      return 'protected result';
    });
    expect(result).toBe('protected result');
    expect(commands).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED', 'SELECT current persisted ACL', 'COMMIT', 'RELEASE',
    ]);
  });
  it('rolls back failure and releases the connection without returning protected data', async () => {
    const commands: string[] = [];
    const client = { query: async (sql: string) => { commands.push(sql); return {}; }, release: () => commands.push('RELEASE') };
    const pool = { connect: async () => client } as unknown as Pool;
    const failure = new Error('scoped operation denied');
    await expect(transaction(pool, async () => { throw failure; })).rejects.toBe(failure);
    expect(commands).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED','ROLLBACK','RELEASE']);
  });
});
