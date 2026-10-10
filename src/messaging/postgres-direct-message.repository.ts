import type { Pool } from 'pg';
import { MessageFailure } from './message-failure';
import { parseSequence } from './message-validation';
import { normalizeMessagePayload, type MessagePayloadInput, type MessageContextReference } from './message-context';
import type { MessageContextResolver, MessageContextCard } from './message-context-resolver';
import { PostgresDirectConversationRepository } from './postgres-direct-conversation.repository';
import type { DirectMessage, MessageHistoryInput, MessageHistoryPage } from './direct-conversation.types';
import { MessageCursorCodec } from './message-cursor';
import { consumeMessageBudget } from './message-rate-limit';

interface MessageRow {
  id: string; conversation_id: string; sender_user_id: string; sequence: string;
  text: string; client_message_id: string; created_at: Date;
  context_type: string | null; context_id: string | null;
}

export class PostgresDirectMessageRepository {
  constructor(private readonly pool: Pool, private readonly conversations: PostgresDirectConversationRepository,
    private readonly cursors?: MessageCursorCodec,
    private readonly contexts?: Pick<MessageContextResolver, 'resolve' | 'resolvePage'>) {}

  async history(actor: string, conversationId: string, input: MessageHistoryInput): Promise<MessageHistoryPage> {
    const cursors = this.cursors;
    if (!cursors) throw new Error('Messaging cursor configuration is required');
    const limit = input.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (input.before !== undefined && input.after !== undefined)) {
      throw new MessageFailure('MESSAGE_INVALID_PAGINATION', 400, 'Message pagination is invalid');
    }
    const ascending = input.after !== undefined;
    const supplied = input.after ?? input.before;
    const boundary = supplied === undefined ? null : cursors.readHistory(supplied, actor, conversationId);
    return this.conversations.withConversation(actor, conversationId, async (client, row) => {
      const result = await client.query<MessageRow>(`SELECT * FROM direct_messages
        WHERE conversation_id=$1 AND ($2::bigint IS NULL OR
          ($3::boolean AND sequence>$2::bigint) OR (NOT $3::boolean AND sequence<$2::bigint))
        ORDER BY sequence ${ascending ? 'ASC' : 'DESC'} LIMIT $4`, [conversationId, boundary, ascending, limit + 1]);
      const selected = result.rows.slice(0, limit);
      if (!ascending) selected.reverse();
      const references = selected.map(reference);
      if (references.some(Boolean) && !this.contexts) throw new Error('Messaging context resolver is required');
      const cards = this.contexts ? await this.contexts.resolvePage(actor, references) : references.map(() => null);
      const items = selected.map((message, index) => project(message, cards[index]));
      const first = items[0]?.sequence ?? boundary ?? row.next_sequence;
      const last = items[items.length - 1]?.sequence ?? (ascending ? boundary ?? '0'
        : (parseSequence(row.next_sequence) - 1n).toString());
      const beforeCursor = cursors.history(actor, conversationId, first);
      const afterCursor = cursors.history(actor, conversationId, last);
      return { items, beforeCursor, afterCursor,
        nextCursor: result.rows.length > limit ? (ascending ? afterCursor : beforeCursor) : null };
    });
  }

  async markRead(actor: string, conversationId: string, input: string): Promise<void> {
    const sequence = parseSequence(input);
    await this.conversations.withConversation(actor, conversationId, async (client, row) => {
      if (sequence >= parseSequence(row.next_sequence) || (sequence > 0n &&
        !(await client.query('SELECT id FROM direct_messages WHERE conversation_id=$1 AND sequence=$2::bigint',
          [conversationId, sequence.toString()])).rowCount)) {
        throw new MessageFailure('MESSAGE_INVALID_READ', 400, 'Read position is invalid');
      }
      const lastRead = actor === row.participant_a_id ? row.last_read_a : row.last_read_b;
      if (sequence <= parseSequence(lastRead)) return;
      if (parseSequence(row.change_version) === 9223372036854775807n) {
        throw new MessageFailure('MESSAGE_CAPACITY_REACHED', 409, 'Conversation capacity reached');
      }
      await client.query(`UPDATE direct_conversations SET
        last_read_a=CASE WHEN participant_a_id=$2 THEN $3::bigint ELSE last_read_a END,
        last_read_b=CASE WHEN participant_b_id=$2 THEN $3::bigint ELSE last_read_b END,
        change_version=change_version+1 WHERE id=$1`, [conversationId, actor, sequence.toString()]);
    });
  }

  async send(actor: string, conversationId: string,
    input: MessagePayloadInput & { clientMessageId: string }): Promise<DirectMessage> {
    const { text, context } = normalizeMessagePayload(input);
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
        if (existing.text !== text || (existing.context_type ?? null) !== (context?.type ?? null)
          || (existing.context_id ?? null) !== (context?.id ?? null))
          throw new MessageFailure('MESSAGE_IDEMPOTENCY_CONFLICT', 409, 'Message retry conflicts');
        // This acknowledges an already committed share. Current pair is checked
        // above; revoked targets return no reference/path/preview and no mutation.
        return { message: project(existing, await this.resolveContext(actor, context)), retryAfter: 0 };
      }
      const card = await this.resolveContext(actor, context);
      if (context && card?.availability !== 'AVAILABLE')
        throw new MessageFailure('MESSAGE_CONTEXT_UNAVAILABLE', 404, 'Content is not available');
      const minute = await consumeMessageBudget(client, actor, 'SEND_MINUTE', 60, 60);
      const hour = await consumeMessageBudget(client, actor, 'SEND_HOUR', 1000, 3600);
      if (minute || hour) return { message: null, retryAfter: Math.max(minute, hour) };
      const sequence = parseSequence(row.next_sequence);
      const version = parseSequence(row.change_version);
      if (sequence === 9223372036854775807n || version === 9223372036854775807n) {
        throw new MessageFailure('MESSAGE_CAPACITY_REACHED', 409, 'Conversation capacity reached');
      }
      const inserted = (await client.query<MessageRow>(`INSERT INTO direct_messages(conversation_id,
        participant_a_id,participant_b_id,sender_user_id,sequence,text,client_message_id,context_type,context_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [conversationId, row.participant_a_id, row.participant_b_id, actor, sequence.toString(), text, input.clientMessageId,
        context?.type ?? null, context?.id ?? null])).rows[0];
      await client.query(`UPDATE direct_conversations SET next_sequence=next_sequence+1,
        change_version=change_version+1,updated_at=clock_timestamp() WHERE id=$1`, [conversationId]);
      const recipient = actor === row.participant_a_id ? row.participant_b_id : row.participant_a_id;
      await client.query(`INSERT INTO direct_message_notification_intents(conversation_id,recipient_user_id,generation)
        VALUES($1,$2,1) ON CONFLICT(conversation_id,recipient_user_id) DO UPDATE SET
        generation=direct_message_notification_intents.generation+1,updated_at=clock_timestamp()`, [conversationId, recipient]);
      return { message: project(inserted, card), retryAfter: 0 };
    });
    // withConversation commits both counters on denial. No message/sequence/intent
    // was changed, and no independent limiter transaction can self-deadlock.
    if (!result.message) throw new MessageFailure('MESSAGE_RATE_LIMITED', 429, 'Too many messages', result.retryAfter);
    return result.message;
  }

  private async resolveContext(actor: string, context: MessageContextReference | null): Promise<MessageContextCard | null> {
    if (!context) return null;
    if (!this.contexts) throw new Error('Messaging context resolver is required');
    return this.contexts.resolve(actor, context);
  }
}

function reference(row: MessageRow): MessageContextReference | null {
  return row.context_type == null && row.context_id == null ? null
    : { type: row.context_type ?? '', id: row.context_id ?? '' } as MessageContextReference;
}

function project(row: MessageRow, context: MessageContextCard | null = null): DirectMessage {
  return { id: row.id, conversationId: row.conversation_id, senderUserId: row.sender_user_id,
    sequence: parseSequence(row.sequence).toString(), text: row.text, clientMessageId: row.client_message_id,
    createdAt: row.created_at.toISOString(), context };
}
