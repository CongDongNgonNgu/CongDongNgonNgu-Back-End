import type { Pool, PoolClient } from 'pg';
import { lockExchangeUsers, EXCHANGE_ELIGIBLE_PREFERENCE_PREDICATE } from '../exchange/exchange-pair-authorization';
import { lockExchangePair } from '../exchange/exchange-safety.repository';
import { conversationUnavailable, MessageFailure } from './message-failure';
import { MessageCursorCodec } from './message-cursor';
import { parseSequence } from './message-validation';
import type { DirectConversationRow, DirectConversationSummary, DirectConversationListInput,
  DirectConversationPage } from './direct-conversation.types';

const EXACT_UPDATED_AT = `to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export class PostgresDirectConversationRepository {
  constructor(private readonly pool: Pool, private readonly cursors?: MessageCursorCodec) {}

  async list(actor: string, input: DirectConversationListInput = {}): Promise<DirectConversationPage> {
    if (!this.cursors) throw new Error('Messaging cursor codec is required');
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new MessageFailure('MESSAGE_INVALID_PAGE', 400, 'Conversation page is invalid');
    const position = input.cursor === undefined ? null : this.cursors.readList(input.cursor, actor);
    // Candidates contain identifiers only and never authorize a projection. Limit
    // work even when retained conversations are no longer accessible.
    const candidates = (await this.pool.query<{ id: string; updatedAt: string }>(`SELECT id,
      ${EXACT_UPDATED_AT} AS "updatedAt" FROM direct_conversations
      WHERE (participant_a_id=$1::uuid OR participant_b_id=$1::uuid)
        AND ($2::timestamptz IS NULL OR (updated_at,id)<($2::timestamptz,$3::uuid))
      ORDER BY updated_at DESC,id DESC LIMIT 101`, [actor, position?.updatedAt ?? null, position?.id ?? null])).rows;
    const items: DirectConversationSummary[] = [];
    let processed = 0;
    for (const candidate of candidates.slice(0, 100)) {
      processed++;
      try {
        const summary = await this.withConversation(actor, candidate.id, async (client, row) => {
          const current = (await client.query<{ updatedAt: string }>(`SELECT ${EXACT_UPDATED_AT} AS "updatedAt"
            FROM direct_conversations WHERE id=$1`, [row.id])).rows[0];
          // Reordering while waiting for locks must not project a new position
          // beneath the old scan cursor. A refresh can pick it up at its new key.
          return current.updatedAt === candidate.updatedAt ? this.summary(client, actor, row) : null;
        });
        if (summary) items.push(summary);
      } catch (error) {
        if (!(error instanceof MessageFailure) || error.code !== 'CONVERSATION_UNAVAILABLE') throw error;
      }
      if (items.length === limit) break;
    }
    return { items, nextCursor: processed > 0 && processed < candidates.length
      ? this.cursors.list(actor, candidates[processed - 1]) : null };
  }

  async open(actor: string, partner: string): Promise<DirectConversationSummary> {
    return this.withPair(actor, partner, async client => {
      const row = (await client.query<DirectConversationRow>(`INSERT INTO direct_conversations
        (participant_a_id,participant_b_id) VALUES(LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid))
        ON CONFLICT(participant_a_id,participant_b_id) DO NOTHING RETURNING *`, [actor, partner])).rows[0]
        ?? (await client.query<DirectConversationRow>(`SELECT * FROM direct_conversations
          WHERE participant_a_id=LEAST($1::uuid,$2::uuid) AND participant_b_id=GREATEST($1::uuid,$2::uuid)
          FOR UPDATE`, [actor, partner])).rows[0];
      if (!row) throw conversationUnavailable();
      return this.summary(client, actor, row);
    });
  }

  async get(actor: string, conversationId: string): Promise<DirectConversationSummary> {
    return this.withConversation(actor, conversationId, (client, row) => this.summary(client, actor, row));
  }

  // Candidate lookup is never authorization and holds no row lock. Current pair
  // and conversation identity are checked again after ordered account/pair locks.
  async withConversation<T>(actor: string, id: string,
    operation: (client: PoolClient, row: DirectConversationRow) => Promise<T>): Promise<T> {
    const candidate = (await this.pool.query<Pick<DirectConversationRow, 'participant_a_id' | 'participant_b_id'>>(
      `SELECT participant_a_id,participant_b_id FROM direct_conversations
        WHERE id=$1::uuid AND (participant_a_id=$2::uuid OR participant_b_id=$2::uuid)`, [id, actor])).rows[0];
    if (!candidate) throw conversationUnavailable();
    const partner = candidate.participant_a_id === actor ? candidate.participant_b_id : candidate.participant_a_id;
    return this.withPair(actor, partner, async client => {
      const row = (await client.query<DirectConversationRow>(`SELECT * FROM direct_conversations
        WHERE id=$1::uuid AND participant_a_id=LEAST($2::uuid,$3::uuid)
          AND participant_b_id=GREATEST($2::uuid,$3::uuid) FOR UPDATE`, [id, actor, partner])).rows[0];
      if (!row) throw conversationUnavailable();
      return operation(client, row);
    });
  }

  private async withPair<T>(actor: string, partner: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const users = await lockExchangeUsers(client, actor, partner);
      await lockExchangePair(client, actor, partner);
      if (actor === partner || users.length !== 2
        || users.some(user => user.status !== 'ACTIVE' || !user.email_verified_at)) throw conversationUnavailable();
      const eligible = await client.query(`SELECT p.user_id FROM language_exchange_preferences p
        WHERE p.user_id IN ($1::uuid,$2::uuid) AND ${EXCHANGE_ELIGIBLE_PREFERENCE_PREDICATE}
          AND p.contact_permission<>'NO_CONTACT'`, [actor, partner]);
      if (eligible.rowCount !== 2) throw conversationUnavailable();
      const relationship = await client.query(`SELECT id FROM language_exchange_connections c
        WHERE c.participant_a_id=LEAST($1::uuid,$2::uuid) AND c.participant_b_id=GREATEST($1::uuid,$2::uuid)
          AND c.status='CONNECTED' AND NOT EXISTS (SELECT 1 FROM language_exchange_blocks b
            WHERE (b.blocker_user_id=$1::uuid AND b.blocked_user_id=$2::uuid)
              OR (b.blocker_user_id=$2::uuid AND b.blocked_user_id=$1::uuid))`, [actor, partner]);
      if (relationship.rowCount !== 1) throw conversationUnavailable();
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async summary(client: PoolClient, actor: string, row: DirectConversationRow): Promise<DirectConversationSummary> {
    const isA = row.participant_a_id === actor;
    const partner = isA ? row.participant_b_id : row.participant_a_id;
    const lastRead = isA ? row.last_read_a : row.last_read_b;
    const user = (await client.query<{ display_name: string }>('SELECT display_name FROM users WHERE id=$1', [partner])).rows[0];
    const unread = (await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM direct_messages
      WHERE conversation_id=$1 AND sender_user_id<>$2 AND sequence>$3::bigint`, [row.id, actor, lastRead])).rows[0].count;
    return { id: row.id, partner: { userId: partner, displayName: user.display_name },
      headSequence: (parseSequence(row.next_sequence) - 1n).toString(),
      changeVersion: parseSequence(row.change_version).toString(), lastReadSequence: parseSequence(lastRead).toString(),
      unreadCount: parseSequence(unread).toString(), updatedAt: row.updated_at.toISOString() };
  }
}
