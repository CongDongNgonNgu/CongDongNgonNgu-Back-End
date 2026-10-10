import type { Pool, PoolClient } from 'pg';
import { MessageFailure } from './message-failure';
import { normalizeMessageText, parseSequence } from './message-validation';
import { PostgresDirectConversationRepository } from './postgres-direct-conversation.repository';
import type { DirectMessage } from './direct-conversation.types';

interface MessageRow {
  id: string; conversation_id: string; sender_user_id: string; sequence: string;
  text: string; client_message_id: string; created_at: Date;
}

export class PostgresDirectMessageRepository {
  constructor(private readonly pool: Pool, private readonly conversations: PostgresDirectConversationRepository) {}

  async send(actor: string, conversationId: string,
    input: { clientMessageId: string; text: string }): Promise<DirectMessage> {
    const text = normalizeMessageText(input.text);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.clientMessageId)) {
      throw new MessageFailure('MESSAGE_INVALID_CLIENT_ID', 400, 'Client message identifier is invalid');
    }
    // Disposable metadata cleanup takes no upstream locks and never retains a
    // counter lock while entering the protected account/pair transaction.
    await this.pool.query(`DELETE FROM direct_message_rate_limits WHERE ctid IN (
      SELECT ctid FROM direct_message_rate_limits WHERE reset_at<=clock_timestamp()
      ORDER BY reset_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
    const result = await this.conversations.withConversation(actor, conversationId, async (client, row) => {
      const existing = (await client.query<MessageRow>(`SELECT * FROM direct_messages
        WHERE conversation_id=$1 AND sender_user_id=$2 AND client_message_id=$3`,
      [conversationId, actor, input.clientMessageId])).rows[0];
      if (existing) {
        if (existing.text !== text) throw new MessageFailure('MESSAGE_IDEMPOTENCY_CONFLICT', 409, 'Message retry conflicts');
        return { message: project(existing), retryAfter: 0 };
      }
      const minute = await consume(client, actor, 'SEND_MINUTE', 60, 60);
      const hour = await consume(client, actor, 'SEND_HOUR', 1000, 3600);
      if (minute || hour) return { message: null, retryAfter: Math.max(minute, hour) };
      const sequence = parseSequence(row.next_sequence);
      const version = parseSequence(row.change_version);
      if (sequence === 9223372036854775807n || version === 9223372036854775807n) {
        throw new MessageFailure('MESSAGE_CAPACITY_REACHED', 409, 'Conversation capacity reached');
      }
      const inserted = (await client.query<MessageRow>(`INSERT INTO direct_messages(conversation_id,
        participant_a_id,participant_b_id,sender_user_id,sequence,text,client_message_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [conversationId, row.participant_a_id, row.participant_b_id, actor, sequence.toString(), text, input.clientMessageId])).rows[0];
      await client.query(`UPDATE direct_conversations SET next_sequence=next_sequence+1,
        change_version=change_version+1,updated_at=clock_timestamp() WHERE id=$1`, [conversationId]);
      const recipient = actor === row.participant_a_id ? row.participant_b_id : row.participant_a_id;
      await client.query(`INSERT INTO direct_message_notification_intents(conversation_id,recipient_user_id,generation)
        VALUES($1,$2,1) ON CONFLICT(conversation_id,recipient_user_id) DO UPDATE SET
        generation=direct_message_notification_intents.generation+1,updated_at=clock_timestamp()`, [conversationId, recipient]);
      return { message: project(inserted), retryAfter: 0 };
    });
    // withConversation commits both counters on denial. No message/sequence/intent
    // was changed, and no independent limiter transaction can self-deadlock.
    if (!result.message) throw new MessageFailure('MESSAGE_RATE_LIMITED', 429, 'Too many messages', result.retryAfter);
    return result.message;
  }
}

async function consume(client: PoolClient, actor: string, bucket: string, limit: number, seconds: number): Promise<number> {
  const row = (await client.query<{ hits: number; retry_seconds: number }>(`
    WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS now)
    INSERT INTO direct_message_rate_limits(actor_id,bucket,hits,reset_at)
    SELECT $1,$2,1,instant.now+make_interval(secs=>$4) FROM instant WHERE true
    ON CONFLICT(actor_id,bucket) DO UPDATE SET
      hits=CASE WHEN direct_message_rate_limits.reset_at<=(SELECT now FROM instant) THEN 1
        ELSE LEAST(direct_message_rate_limits.hits+1,$3+1) END,
      reset_at=CASE WHEN direct_message_rate_limits.reset_at<=(SELECT now FROM instant)
        THEN (SELECT now FROM instant)+make_interval(secs=>$4) ELSE direct_message_rate_limits.reset_at END
    RETURNING hits,GREATEST(1,CEIL(EXTRACT(EPOCH FROM reset_at-(SELECT now FROM instant))))::int AS retry_seconds`,
  [actor, bucket, limit, seconds])).rows[0];
  return row.hits > limit ? row.retry_seconds : 0;
}

function project(row: MessageRow): DirectMessage {
  return { id: row.id, conversationId: row.conversation_id, senderUserId: row.sender_user_id,
    sequence: parseSequence(row.sequence).toString(), text: row.text, clientMessageId: row.client_message_id,
    createdAt: row.created_at.toISOString() };
}
