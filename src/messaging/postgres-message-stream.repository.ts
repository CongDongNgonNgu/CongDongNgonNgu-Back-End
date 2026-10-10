import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { SessionFailure } from '../auth/session/session.service';
import { PostgresDirectConversationRepository } from './postgres-direct-conversation.repository';
import { MessageFailure } from './message-failure';
import { consumeMessageBudget } from './message-rate-limit';
import { parseSequence } from './message-validation';

export interface MessageStreamLease {
  readonly id: string;
  readonly ownerToken: string;
  readonly actor: string;
  readonly conversationId: string;
  readonly sessionId: string;
}

export interface MessageStreamRepository {
  acquire(actor: string, conversationId: string, sessionId: string): Promise<MessageStreamLease>;
  poll(lease: MessageStreamLease): Promise<string>;
  release(lease: MessageStreamLease): Promise<void>;
}

export class PostgresMessageStreamRepository implements MessageStreamRepository {
  constructor(private readonly pool: Pool, private readonly conversations: PostgresDirectConversationRepository) {}

  async acquire(actor: string, conversationId: string, sessionId: string): Promise<MessageStreamLease> {
    // Never hold disposable metadata locks while waiting for account/pair locks.
    await this.pool.query(`DELETE FROM direct_message_stream_leases WHERE ctid IN (
      SELECT ctid FROM direct_message_stream_leases WHERE expires_at<=clock_timestamp()
      ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
    await this.pool.query(`DELETE FROM direct_message_rate_limits WHERE ctid IN (
      SELECT ctid FROM direct_message_rate_limits WHERE reset_at<=clock_timestamp()
      ORDER BY reset_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
    const result = await this.conversations.withConversation(actor, conversationId, async client => {
      await assertSession(client, actor, sessionId);
      const retryAfter = await consumeMessageBudget(client, actor, 'STREAM_MINUTE', 30, 60);
      if (retryAfter) return { lease: null, code: 'MESSAGE_STREAM_RATE_LIMITED', retryAfter };
      // The account row serializes acquisitions for this actor across every pair
      // and replica. Clock reads occur after all upstream lock waits.
      await client.query('DELETE FROM direct_message_stream_leases WHERE actor_id=$1 AND expires_at<=clock_timestamp()', [actor]);
      const capacity = (await client.query<{ count: string; retry_seconds: number }>(`SELECT count(*)::text AS count,
        GREATEST(1,CEIL(EXTRACT(EPOCH FROM min(expires_at)-clock_timestamp())))::int AS retry_seconds
        FROM direct_message_stream_leases WHERE actor_id=$1 AND expires_at>clock_timestamp()`, [actor])).rows[0];
      if (Number(capacity.count) >= 10)
        return { lease: null, code: 'MESSAGE_STREAM_LIMIT', retryAfter: capacity.retry_seconds };
      const lease: MessageStreamLease = { id: randomUUID(), ownerToken: randomUUID(), actor, conversationId, sessionId };
      await client.query(`INSERT INTO direct_message_stream_leases(id,owner_token,actor_id,conversation_id,session_id,expires_at)
        VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '60 seconds')`, values(lease));
      return { lease, code: '', retryAfter: 0 };
    });
    // Authorized attempts remain counted on rate/capacity denial, without a lease.
    if (!result.lease) throw new MessageFailure(result.code, 429, 'Too many message stream attempts', result.retryAfter);
    return result.lease;
  }

  async poll(lease: MessageStreamLease): Promise<string> {
    return this.conversations.withConversation(lease.actor, lease.conversationId, async (client, conversation) => {
      // Acquire the final row lock before sampling expiry. UPDATE's predicate
      // alone can be evaluated before a row-lock wait without a changed tuple.
      await client.query(`SELECT id FROM direct_message_stream_leases
        WHERE id=$1 AND owner_token=$2 AND actor_id=$3 AND conversation_id=$4 AND session_id=$5
        FOR UPDATE`, values(lease));
      const renewed = await client.query(`UPDATE direct_message_stream_leases
        SET expires_at=clock_timestamp()+interval '60 seconds'
        WHERE id=$1 AND owner_token=$2 AND actor_id=$3 AND conversation_id=$4 AND session_id=$5
          AND expires_at>clock_timestamp() RETURNING id`, values(lease));
      if (!renewed.rowCount) throw new MessageFailure('MESSAGE_STREAM_EXPIRED', 409, 'Message stream has expired');
      await assertSession(client, lease.actor, lease.sessionId);
      return parseSequence(conversation.change_version).toString();
    });
  }

  async release(lease: MessageStreamLease): Promise<void> {
    // Cancellation takes no upstream locks; stale ownership cannot erase a new lease.
    await this.pool.query(`DELETE FROM direct_message_stream_leases
      WHERE id=$1 AND owner_token=$2 AND actor_id=$3 AND conversation_id=$4 AND session_id=$5`, values(lease));
  }
}

function values(lease: MessageStreamLease): string[] {
  return [lease.id, lease.ownerToken, lease.actor, lease.conversationId, lease.sessionId];
}

async function assertSession(client: PoolClient, actor: string, sessionId: string): Promise<void> {
  const session = await client.query(`SELECT id FROM auth_sessions
    WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [sessionId, actor]);
  if (!session.rowCount) throw new SessionFailure('AUTH_SESSION_EXPIRED');
}
