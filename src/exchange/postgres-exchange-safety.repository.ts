import type { Pool, PoolClient } from 'pg';
import { lockExchangePair } from './exchange-safety.repository';
import type {
  ExchangeBlockMutationResult,
  ExchangeReportInput,
  ExchangeReportMutationResult,
  ExchangeSafetyRepository,
} from './exchange-safety.types';

export class PostgresExchangeSafetyRepository implements ExchangeSafetyRepository {
  constructor(private readonly pool: Pool) {}

  async isBlocked(firstUserId: string, secondUserId: string): Promise<boolean> {
    const result = await this.pool.query(
      BLOCK_EXISTS_SQL,
      [firstUserId, secondUserId],
    );
    return Boolean(result.rows[0]?.blocked);
  }

  async isBlockedBy(blockerUserId: string, blockedUserId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1
           FROM language_exchange_blocks
          WHERE blocker_user_id = $1::uuid
            AND blocked_user_id = $2::uuid
       ) AS blocked`,
      [blockerUserId, blockedUserId],
    );
    return Boolean(result.rows[0]?.blocked);
  }

  async isBlockedOnClient(
    client: PoolClient,
    firstUserId: string,
    secondUserId: string,
  ): Promise<boolean> {
    const result = await client.query(BLOCK_EXISTS_SQL, [firstUserId, secondUserId]);
    return Boolean(result.rows[0]?.blocked);
  }

  async blockUser(blockerUserId: string, blockedUserId: string): Promise<ExchangeBlockMutationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockExchangePair(client, blockerUserId, blockedUserId);
      const inserted = await client.query(
        `INSERT INTO language_exchange_blocks (blocker_user_id, blocked_user_id)
         VALUES ($1::uuid, $2::uuid)
         ON CONFLICT (blocker_user_id, blocked_user_id) DO NOTHING
         RETURNING blocker_user_id`,
        [blockerUserId, blockedUserId],
      );
      const removed = await client.query(
        `DELETE FROM language_exchange_connections
          WHERE participant_a_id = LEAST($1::uuid, $2::uuid)
            AND participant_b_id = GREATEST($1::uuid, $2::uuid)
          RETURNING id, requester_user_id`,
        [blockerUserId, blockedUserId],
      );
      await client.query('COMMIT');
      const removedRelationship = removed.rows[0] as {
        id?: unknown;
        requester_user_id?: unknown;
      } | undefined;
      return {
        targetUserId: blockedUserId,
        outcome: inserted.rows.length > 0 ? 'CREATED' : 'ALREADY_BLOCKED',
        relationshipRemoval: 'ATOMIC',
        ...(removedRelationship?.id
          ? {
              removedConnectionId: String(removedRelationship.id),
              removedRequesterUserId: removedRelationship.requester_user_id
                ? String(removedRelationship.requester_user_id)
                : undefined,
            }
          : {}),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async unblockUser(blockerUserId: string, blockedUserId: string): Promise<ExchangeBlockMutationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockExchangePair(client, blockerUserId, blockedUserId);
      const result = await client.query(
        `DELETE FROM language_exchange_blocks
          WHERE blocker_user_id = $1::uuid
            AND blocked_user_id = $2::uuid`,
        [blockerUserId, blockedUserId],
      );
      await client.query('COMMIT');
      return {
        targetUserId: blockedUserId,
        outcome: result.rowCount === 1 ? 'REMOVED' : 'NOT_BLOCKED',
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async submitReport(input: ExchangeReportInput): Promise<ExchangeReportMutationResult> {
    const result = await this.pool.query(
      `INSERT INTO language_exchange_reports (
         reporter_user_id, target_user_id, category, context
       )
       VALUES ($1::uuid, $2::uuid, $3::exchange_report_category, $4)
       ON CONFLICT (reporter_user_id, target_user_id, category)
         WHERE state IN ('OPEN'::exchange_report_state, 'IN_REVIEW'::exchange_report_state)
       DO NOTHING
       RETURNING id`,
      [input.reporterUserId, input.targetUserId, input.category, input.context],
    );
    return { duplicate: result.rows.length === 0 };
  }
}

const BLOCK_EXISTS_SQL = `
  SELECT EXISTS (
    SELECT 1
      FROM language_exchange_blocks
     WHERE (blocker_user_id = $1::uuid AND blocked_user_id = $2::uuid)
        OR (blocker_user_id = $2::uuid AND blocked_user_id = $1::uuid)
  ) AS blocked`;
