import { describe, expect, it, jest } from '@jest/globals';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { PostgresEventParticipationRepository } from './postgres-event-participation.repository';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const REGISTRATION_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-03T00:00:00.000Z');

describe('PostgresEventParticipationRepository cancellation', () => {
  it('binds cancellation timestamps without leaving an untyped PostgreSQL parameter', async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const current = registrationRow('REGISTERED');
    const cancelled = registrationRow('CANCELLED');
    const client = {
      query: jest.fn(async <T extends QueryResultRow = QueryResultRow>(
        text: string,
        values: readonly unknown[] = [],
      ) => {
        calls.push({ text, values });
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
          return { rows: [] as T[] };
        }
        if (text.includes('SELECT id, capacity FROM community_events')) {
          return { rows: [{ id: EVENT_ID, capacity: 1 }] as unknown as T[] };
        }
        if (text.includes('SELECT * FROM event_registrations') && text.includes('FOR UPDATE')) {
          return { rows: [current] as unknown as T[] };
        }
        if (text.includes("status = 'CANCELLED'::event_registration_status")) {
          if (values.length !== 2 || values[0] !== REGISTRATION_ID || values[1] !== NOW) {
            const error = Object.assign(
              new Error('could not determine data type of parameter $2'),
              { code: '42P18' },
            );
            throw error;
          }
          return { rows: [cancelled] as unknown as T[] };
        }
        if (text.includes('SELECT COUNT(*)::int AS count')) {
          return { rows: [{ count: 1 }] as unknown as T[] };
        }
        if (text.includes('WITH ranked AS')) {
          return { rows: [] as T[] };
        }
        throw new Error(`Unexpected query in cancellation test: ${text}`);
      }),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = {
      connect: jest.fn(async () => client),
    } as unknown as Pool;

    const repository = new PostgresEventParticipationRepository(pool);
    const result = await repository.cancelRegistration(
      { id: EVENT_ID, capacity: 1 },
      USER_ID,
      NOW,
    );

    expect(result).toMatchObject({
      replayed: false,
      promoted: [],
      record: {
        id: REGISTRATION_ID,
        eventId: EVENT_ID,
        userId: USER_ID,
        status: 'CANCELLED',
        cancelledAt: NOW,
      },
    });
    const cancellation = calls.find((call) =>
      call.text.includes('SET status = \'CANCELLED\'::event_registration_status'),
    );
    expect(cancellation?.text).toContain('cancelled_at = $2');
    expect(cancellation?.text).toContain('updated_at = $2');
    expect(cancellation?.text).not.toContain('$3');
    expect(cancellation?.values).toEqual([REGISTRATION_ID, NOW]);
    expect(calls.map((call) => call.text)).toEqual(
      expect.arrayContaining(['BEGIN', 'COMMIT']),
    );
    expect(calls.map((call) => call.text)).not.toContain('ROLLBACK');
  });
});

function registrationRow(status: 'REGISTERED' | 'CANCELLED'): QueryResultRow {
  return {
    id: REGISTRATION_ID,
    event_id: EVENT_ID,
    user_id: USER_ID,
    status,
    waitlist_position: null,
    registered_at: NOW,
    cancelled_at: status === 'CANCELLED' ? NOW : null,
    created_at: NOW,
    updated_at: NOW,
  };
}
