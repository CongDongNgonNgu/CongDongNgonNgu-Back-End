import type { Pool, PoolClient } from 'pg';
import type {
  ExchangeConnectionMutationResult,
  ExchangeConnectionRecord,
} from './exchange-connection.types';
import type { ExchangeConnectionRepository } from './exchange-connection.repository';
import { lockExchangePair } from './exchange-safety.repository';
import type { ExchangeSafetyReadStore } from './exchange-safety.types';
import { authorizeConnectionPair, lockExchangeUsers } from './exchange-pair-authorization';
import { ExchangeFailure } from './exchange.errors';
import { ConnectionCursorCodec } from './connection-cursor-codec';
import { consumeNewConnectionPair } from './exchange-action-limiter';
import { enqueueConnectionNotification } from './exchange-notification-outbox';
import { connectionListQuery, connectionListMatches, connectionListItem, connectionListCursor,
  type ConnectionListInput, type ConnectionListPage } from './exchange-connection-list';

export class PostgresExchangeConnectionRepository implements ExchangeConnectionRepository {
  constructor(
    private readonly pool: Pool,
    private readonly safety?: ExchangeSafetyReadStore,
    private readonly cursors = new ConnectionCursorCodec(),
  ) {}

  async listRelationships(actor: string, input: ConnectionListInput): Promise<ConnectionListPage> {
    const query = connectionListQuery(actor,input,this.cursors);
    // Millisecond precision matches the wire cursor and JS Date; UUID breaks ties.
    const result = await this.pool.query(`
      SELECT id, participant_a_id, participant_b_id, requester_id, status, created_at, updated_at
      FROM language_exchange_connections c
      WHERE (participant_a_id=$1::uuid OR participant_b_id=$1::uuid)
        AND (($2='CONNECTED' AND status='CONNECTED')
          OR ($2='OUTGOING' AND status='PENDING' AND requester_id=$1::uuid)
          OR ($2='INCOMING' AND status='PENDING' AND requester_id<>$1::uuid))
        AND ($3::timestamptz IS NULL OR (date_trunc('milliseconds',updated_at),id)<($3::timestamptz,$4::uuid))
        AND NOT EXISTS (SELECT 1 FROM language_exchange_blocks b WHERE
          (b.blocker_user_id=c.participant_a_id AND b.blocked_user_id=c.participant_b_id)
          OR (b.blocker_user_id=c.participant_b_id AND b.blocked_user_id=c.participant_a_id))
      ORDER BY date_trunc('milliseconds',updated_at) DESC,id DESC LIMIT $5`,
      [actor,query.kind,query.cursor?.updatedAt ?? null,query.cursor?.id ?? null,query.limit+1]);
    const records = result.rows.map(row => mapRow(row)!);
    const page = records.slice(0,query.limit);
    const items: ConnectionListPage['items'] = [];
    for (const record of page) {
      const target = record.participantAId===actor ? record.participantBId : record.participantAId;
      try {
        const item = await this.withLockedRelationship(actor,target,async (client,current,blocked) => {
          if (blocked || !current || !connectionListMatches(current,actor,query.kind)) return null;
          if (current.id!==record.id || current.updatedAt.getTime()!==record.updatedAt.getTime()) return null;
          const user = (await client.query('SELECT display_name FROM users WHERE id=$1',[target])).rows[0];
          return {...connectionListItem(current,actor),displayName:String(user.display_name)};
        },'ELIGIBLE');
        if (item) items.push(item);
      } catch (error) {
        if (!(error instanceof ExchangeFailure && error.code==='EXCHANGE_PROFILE_UNAVAILABLE')) throw error;
      }
    }
    return {items,nextCursor:records.length>query.limit
      ? connectionListCursor(actor,query.kind,page[page.length-1],this.cursors) : null};
  }

  async findRelationship(firstUserId: string, secondUserId: string): Promise<ExchangeConnectionRecord | null> {
    return this.withLockedRelationship(firstUserId, secondUserId, async (_client, current, blocked) => {
      return blocked ? null : current;
    }, 'READ');
  }

  async requestConnection(
    requesterUserId: string,
    targetUserId: string,
  ): Promise<ExchangeConnectionMutationResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.withLockedRelationship(requesterUserId, targetUserId, async (client, current, blocked) => {
          if (blocked) return { record: null, outcome: 'SAFETY_BLOCKED' as const };
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
            const mutation={record:mapRow(result.rows[0]),outcome:'CONNECTED' as const};
            await enqueueConnectionNotification(client,requesterUserId,mutation);
            return mutation;
          }
          await consumeNewConnectionPair(client,requesterUserId,targetUserId);
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
          const mutation={record:mapRow(result.rows[0]),outcome:'REQUESTED' as const};
          await enqueueConnectionNotification(client,requesterUserId,mutation);
          return mutation;
        }, 'REQUEST');
      } catch (error) {
        if (attempt === 0 && isUniqueViolation(error)) continue;
        throw error;
      }
    }
    throw new Error('Connection request could not be persisted');
  }

  acceptConnection(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult> {
    return this.withLockedRelationship(actorUserId, targetUserId, async (client, current, blocked) => {
      if (blocked) return { record: null, outcome: 'SAFETY_BLOCKED' as const };
      if (!current) return { record: null, outcome: 'INVALID_ACTION' as const };
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
      const mutation={record:mapRow(result.rows[0]),outcome:'ACCEPTED' as const};
      await enqueueConnectionNotification(client,actorUserId,mutation);
      return mutation;
    }, 'ELIGIBLE');
  }

  declineConnection(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult> {
    return this.withLockedRelationship(actorUserId, targetUserId, async (client, current, blocked) => {
      if (blocked) return { record: null, outcome: 'SAFETY_BLOCKED' as const };
      if (!current) return { record: null, outcome: 'INVALID_ACTION' as const };
      if (current.status !== 'PENDING' || current.requesterId === actorUserId) {
        return { record: current, outcome: 'INVALID_ACTION' as const };
      }
      await client.query('DELETE FROM language_exchange_connections WHERE id = $1', [current.id]);
      return { record: null, connectionId: current.id, requesterUserId: current.requesterId, outcome: 'DECLINED' as const };
    });
  }

  cancelConnection(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult> {
    return this.withLockedRelationship(actorUserId, targetUserId, async (client, current, blocked) => {
      if (blocked) return { record: null, outcome: 'SAFETY_BLOCKED' as const };
      if (!current) return { record: null, outcome: 'INVALID_ACTION' as const };
      if (current.status !== 'PENDING' || current.requesterId !== actorUserId) {
        return { record: current, outcome: 'INVALID_ACTION' as const };
      }
      await client.query('DELETE FROM language_exchange_connections WHERE id = $1', [current.id]);
      return { record: null, connectionId: current.id, requesterUserId: current.requesterId, outcome: 'CANCELLED' as const };
    });
  }

  disconnect(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult> {
    return this.withLockedRelationship(actorUserId, targetUserId, async (client, current, blocked) => {
      if (blocked) return { record: null, outcome: 'SAFETY_BLOCKED' as const };
      if (!current) return { record: null, outcome: 'INVALID_ACTION' as const };
      if (current.status !== 'CONNECTED') {
        return { record: current, outcome: 'INVALID_ACTION' as const };
      }
      await client.query('DELETE FROM language_exchange_connections WHERE id = $1', [current.id]);
      return { record: null, connectionId: current.id, requesterUserId: current.requesterId, outcome: 'DISCONNECTED' as const };
    });
  }

  async removeRelationshipForSafety(
    firstUserId: string,
    secondUserId: string,
  ): Promise<ExchangeConnectionMutationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await lockExchangeUsers(client, firstUserId, secondUserId);
      await lockExchangePair(client, firstUserId, secondUserId);
      const currentResult = await client.query(
        `SELECT id, participant_a_id, participant_b_id, requester_id, status, created_at, updated_at
           FROM language_exchange_connections
          WHERE participant_a_id = LEAST($1::uuid, $2::uuid)
            AND participant_b_id = GREATEST($1::uuid, $2::uuid)
          FOR UPDATE`,
        [firstUserId, secondUserId],
      );
      const current = mapRow(currentResult.rows[0]);
      if (!current) {
        await client.query('COMMIT');
        return { record: null, outcome: 'NONE' as const };
      }
      await client.query('DELETE FROM language_exchange_connections WHERE id = $1', [current.id]);
      await client.query('COMMIT');
      return {
        record: null,
        connectionId: current.id,
        requesterUserId: current.requesterId,
        outcome: 'SAFETY_REMOVED' as const,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async withLockedRelationship<T>(
    firstUserId: string,
    secondUserId: string,
    operation: (
      client: PoolClient,
      current: ExchangeConnectionRecord | null,
      blocked: boolean,
    ) => Promise<T>,
    authorization: 'READ' | 'ACTOR' | 'ELIGIBLE' | 'REQUEST' = 'ACTOR',
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const users = await lockExchangeUsers(client, firstUserId, secondUserId);
      await lockExchangePair(client, firstUserId, secondUserId);
      const blocked = this.safety
        ? await this.safety.isBlockedOnClient(client, firstUserId, secondUserId)
        : false;
      if (!blocked) {
        await authorizeConnectionPair(client, users, firstUserId, secondUserId,
          authorization === 'ELIGIBLE' || authorization === 'REQUEST', authorization === 'REQUEST');
        if (authorization === 'READ') {
          await authorizeConnectionPair(client, users, secondUserId, firstUserId, false);
        }
      }
      const currentResult = await client.query(
        `SELECT id, participant_a_id, participant_b_id, requester_id, status, created_at, updated_at
           FROM language_exchange_connections
          WHERE participant_a_id = LEAST($1::uuid, $2::uuid)
            AND participant_b_id = GREATEST($1::uuid, $2::uuid)
          FOR UPDATE`,
        [firstUserId, secondUserId],
      );
      const result = await operation(client, mapRow(currentResult.rows[0]), blocked);
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
