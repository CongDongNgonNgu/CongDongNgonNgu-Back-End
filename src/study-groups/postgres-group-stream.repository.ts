import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { SessionFailure } from '../auth/session/session.service';
import type {
  MessageStreamLease,
  MessageStreamRepository,
} from '../messaging/postgres-message-stream.repository';
import { MessageFailure } from '../messaging/message-failure';
import { consumeMessageBudget } from '../messaging/message-rate-limit';
import {
  authorize,
  lockAccounts,
  lockGroup,
  transaction,
} from './study-group.store';
export class PostgresGroupStreamRepository implements MessageStreamRepository {
  constructor(private readonly pool: Pool) {}
  async acquire(
    actor: string,
    groupId: string,
    sessionId: string,
  ): Promise<MessageStreamLease> {
    const result = await transaction(this.pool, async (client) => {
      await lockAccounts(client, [actor], true);
      const group = await lockGroup(client, groupId, false);
      await authorize(client, group.id, actor);
      await this.session(client, actor, sessionId);
      const retry = await consumeMessageBudget(
        client,
        actor,
        'STREAM_MINUTE',
        30,
        60,
      );
      if (retry) return { retry, code: 'MESSAGE_STREAM_RATE_LIMITED' };
      await client.query(
        'DELETE FROM direct_message_stream_leases WHERE actor_id=$1 AND expires_at<=clock_timestamp()',
        [actor],
      );
      const capacity = (
        await client.query<{ count: string; retry: number }>(
          'SELECT count(*)::text AS count,GREATEST(1,CEIL(EXTRACT(EPOCH FROM min(expires_at)-clock_timestamp())))::int AS retry FROM direct_message_stream_leases WHERE actor_id=$1 AND expires_at>clock_timestamp()',
          [actor],
        )
      ).rows[0];
      if (Number(capacity.count) >= 10)
        return { retry: capacity.retry, code: 'MESSAGE_STREAM_LIMIT' };
      const lease = {
        id: randomUUID(),
        ownerToken: randomUUID(),
        actor,
        conversationId: groupId,
        sessionId,
      };
      await client.query(
        "INSERT INTO direct_message_stream_leases(id,owner_token,actor_id,group_id,session_id,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '60 seconds')",
        this.values(lease),
      );
      return { lease };
    });
    if (!result.lease)
      throw new MessageFailure(
        result.code!,
        429,
        'Too many communication streams',
        result.retry,
      );
    return result.lease;
  }
  async poll(lease: MessageStreamLease): Promise<string> {
    return transaction(this.pool, async (client) => {
      await lockAccounts(client, [lease.actor], false);
      const group = await lockGroup(client, lease.conversationId, false);
      await authorize(client, group.id, lease.actor);
      await client.query(
        'SELECT id FROM direct_message_stream_leases WHERE id=$1 AND owner_token=$2 AND actor_id=$3 AND group_id=$4 AND session_id=$5 FOR UPDATE',
        this.values(lease),
      );
      const row = await client.query(
        "UPDATE direct_message_stream_leases SET expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1 AND owner_token=$2 AND actor_id=$3 AND group_id=$4 AND session_id=$5 AND expires_at>clock_timestamp() RETURNING id",
        this.values(lease),
      );
      if (!row.rowCount)
        throw new MessageFailure(
          'MESSAGE_STREAM_EXPIRED',
          409,
          'Communication stream expired',
        );
      await this.session(client, lease.actor, lease.sessionId);
      return String(group.change_version);
    });
  }
  async release(lease: MessageStreamLease) {
    await this.pool.query(
      'DELETE FROM direct_message_stream_leases WHERE id=$1 AND owner_token=$2 AND actor_id=$3 AND group_id=$4 AND session_id=$5',
      this.values(lease),
    );
  }
  private values(lease: MessageStreamLease) {
    return [
      lease.id,
      lease.ownerToken,
      lease.actor,
      lease.conversationId,
      lease.sessionId,
    ];
  }
  private async session(
    client: import('pg').PoolClient,
    actor: string,
    id: string,
  ) {
    if (
      !(
        await client.query(
          'SELECT id FROM auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()',
          [id, actor],
        )
      ).rowCount
    )
      throw new SessionFailure('AUTH_SESSION_EXPIRED');
  }
}
