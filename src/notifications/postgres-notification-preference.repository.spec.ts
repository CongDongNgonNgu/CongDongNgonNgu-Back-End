import { describe, expect, it, jest } from '@jest/globals';
import type { Pool } from 'pg';
import { PostgresNotificationPreferenceRepository } from './postgres-notification-preference.repository';

const USER_ID = '11111111-1111-4111-8111-111111111111';

type QueryResult = {
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
};
type QueryFn = (...args: unknown[]) => Promise<QueryResult>;

describe('PostgresNotificationPreferenceRepository', () => {
  it('loads only the authenticated owner overrides with parameterized SQL', async () => {
    const query = jest.fn<QueryFn>().mockResolvedValue({
      rows: [{ category: 'COMMUNITY', channel: 'SSE', enabled: false }],
    });
    const repository = new PostgresNotificationPreferenceRepository({ query } as unknown as Pool);

    await expect(repository.findOverrides(USER_ID)).resolves.toEqual([
      { category: 'COMMUNITY', channel: 'SSE', enabled: false },
    ]);
    expect(query.mock.calls[0][0]).not.toContain(USER_ID);
    expect(query.mock.calls[0][1]).toEqual([USER_ID]);
  });

  it('updates a preference matrix atomically and parameterizes category/channel values', async () => {
    const clientQuery = jest.fn<QueryFn>().mockResolvedValue({ rows: [] });
    const connect = jest.fn<() => Promise<{ query: QueryFn; release: () => void }>>().mockResolvedValue({
      query: clientQuery,
      release: () => undefined,
    });
    const repository = new PostgresNotificationPreferenceRepository({ connect } as unknown as Pool);

    await repository.saveOverrides(USER_ID, [
      { category: 'COMMUNITY', channel: 'SSE', enabled: false },
      { category: 'COMMUNITY', channel: 'EMAIL', enabled: true },
    ]);

    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('ORDER BY id FOR UPDATE'),
      expect.stringContaining('ON CONFLICT (user_id, category, channel)'),
      expect.stringContaining('ON CONFLICT (user_id, category, channel)'),
      'COMMIT',
    ]);
    expect(clientQuery.mock.calls[1][1]).toEqual([USER_ID]);
    expect(clientQuery.mock.calls[2][1]).toEqual([USER_ID, 'COMMUNITY', 'SSE', false]);
    expect(clientQuery.mock.calls[3][1]).toEqual([USER_ID, 'COMMUNITY', 'EMAIL', true]);
  });
});
