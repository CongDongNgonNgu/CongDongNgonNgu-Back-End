import type { Pool, PoolClient } from 'pg';
import type {
  ExchangeConnectionMutationResult,
  ExchangeConnectionRecord,
} from './exchange-connection.types';
import type { ExchangeConnectionRepository } from './exchange-connection.repository';

export class PostgresExchangeConnectionRepository implements ExchangeConnectionRepository {
  constructor(private readonly pool: Pool) {}

  async findRelationship(firstUserId: string, secondUserId: string): Promise<ExchangeConnectionRecord | null> {
    const result = await this.pool.query(
      `SELECT id, participant_a_id, participant_b_id, requester_id, status, created_at, updated_at
         FROM language_exchange_connections
        WHERE participant_a_id = LEAST($1::uuid, $2::uuid)
          AND participant_b_id = GREATEST($1::uuid, $2::uuid)`,
      [firstUserId, secondUserId],
    );
    return mapRow(result.rows[0]);
  }

  async requestConnection(
    requesterUserId: string,
    targetUserId: string,
  ): Promise<ExchangeConnectionMutationResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.withLockedRelationship(requesterUserId, targetUserId, async (client, current) => {
          if (current?.status === 'CONNECTED') {
            return { record: current, outcome: 'ALREADY_CONNECTED' as const };
          }
          if (current?.requesterId === requesterUserId) {
            return { record: current, outcome: 'ALREADY_PENDING' as const };
          }
          if (current) {
            const result = await client.query(
              `UPDATE language_exchange_connections
                  SET status = 'CONNECTED'::exchange_connection_status,
                      updated_at = now()
                WHERE id = $1
                RETURNING id, participant_a_id, participant_b_id, requester_id, status, created_at, updated_at`,
              [current.id],
            );
            return { record: mapRow(result.rows[0]), outcome: 'CONNECTED' as const };
          }
          const result = await client.query(
            `INSERT INTO language_exchange_connections (
               participant_a_id, participant_b_id, requester_id, status
             )
             VALUES (
               LEAST($1::uuid, $2::uuid),
               GREATEST($1::uuid, $2::uuid),
               $1,
               'PENDING'::exchange_connection_status
             )
             RETURNING id, participant_a_id, participant_b_id, requester_id, status, created_at, updated_at`,
            [requesterUserId, targetUserId],
          );
          return { record: mapRow(result.rows[0]), outcome: 'REQUESTED' as const };
        });
      } catch (error) {
        if (attempt === 0 && isUniqueViolation(error)) continue;
        throw error;
      }
    }
    throw new Error('Connection request could not be persisted');
  }

  acceptConnection(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult> {
    return this.withLockedRelationship(actorUserId, targetUserId, async (client, current) => {
      if (!current) return { record: null, outcome: 'NONE' as const };
      if (current.status === 'CONNECTED') return { record: current, outcome: 'ALREADY_CONNECTED' as const };
      if (current.requesterId === actorUserId) return { record: current, outcome: 'INVALID_ACTION' as const };
      const result = await client.query(
        `UPDATE language_exchange_connections
            SET status = 'CONNECTED'::exchange_connection_status,
                updated_at = now()
          WHERE id = $1
          RETURNING id, participant_a_id, participant_b_id, requester_id, status, created_at, updated_at`,
        [current.id],
      );
      return { record: mapRow(result.rows[0]), outcome: 'ACCEPTED' as const };
    });
  }

  declineConnection(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult> {
    return this.withLockedRelationship(actorUserId, targetUserId, async (client, current) => {
      if (!current) return { record: null, outcome: 'NONE' as const };
      if (current.status !== 'PENDING' || current.requesterId === actorUserId) {
        return { record: current, outcome: 'INVALID_ACTION' as const };
      }
      await client.query('DELETE FROM language_exchange_connections WHERE id = $1', [current.id]);
      return { record: null, connectionId: current.id, requesterUserId: current.requesterId, outcome: 'DECLINED' as const };
    });
  }

  cancelConnection(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult> {
    return this.withLockedRelationship(actorUserId, targetUserId, async (client, current) => {
      if (!current) return { record: null, outcome: 'NONE' as const };
      if (current.status !== 'PENDING' || current.requesterId !== actorUserId) {
        return { record: current, outcome: 'INVALID_ACTION' as const };
      }
      await client.query('DELETE FROM language_exchange_connections WHERE id = $1', [current.id]);
      return { record: null, connectionId: current.id, requesterUserId: current.requesterId, outcome: 'CANCELLED' as const };
    });
  }

  disconnect(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult> {
    return this.withLockedRelationship(actorUserId, targetUserId, async (client, current) => {
      if (!current) return { record: null, outcome: 'NONE' as const };
      if (current.status !== 'CONNECTED') {
        return { record: current, outcome: 'INVALID_ACTION' as const };
      }
      await client.query('DELETE FROM language_exchange_connections WHERE id = $1', [current.id]);
      return { record: null, connectionId: current.id, requesterUserId: current.requesterId, outcome: 'DISCONNECTED' as const };
    });
  }

  private async withLockedRelationship<T>(
    firstUserId: string,
    secondUserId: string,
    operation: (client: PoolClient, current: ExchangeConnectionRecord | null) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query(
        `SELECT id, participant_a_id, participant_b_id, requester_id, status, created_at, updated_at
           FROM language_exchange_connections
          WHERE participant_a_id = LEAST($1::uuid, $2::uuid)
            AND participant_b_id = GREATEST($1::uuid, $2::uuid)
          FOR UPDATE`,
        [firstUserId, secondUserId],
      );
      const result = await operation(client, mapRow(currentResult.rows[0]));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapRow(row: Record<string, unknown> | undefined): ExchangeConnectionRecord | null {
  if (!row) return null;
  return {
    id: String(row.id),
    participantAId: String(row.participant_a_id),
    participantBId: String(row.participant_b_id),
    requesterId: String(row.requester_id),
    status: String(row.status) as ExchangeConnectionRecord['status'],
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toDate(value: unknown): Date {
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error('Invalid connection timestamp');
  return date;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === '23505';
}
