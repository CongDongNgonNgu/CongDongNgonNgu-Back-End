import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import type { NotificationRecord } from '../notifications/notification.contracts';
import type { PostgresNotificationRepository } from '../notifications/postgres-notification.repository';
import type { NotificationRealtimeService } from '../notifications/notification-realtime.service';
import type { PostgresDirectConversationRepository } from './postgres-direct-conversation.repository';
import { directMessageNotificationIntent } from './direct-message-notification-intent';
import { MessageFailure } from './message-failure';

interface Candidate { conversation_id: string; recipient_user_id: string; generation: string }
interface BatchResult { processed: number; failed: number }

export class DirectMessageNotificationWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<BatchResult>;
  private stopped = false;
  constructor(private readonly pool: Pool,
    private readonly conversations: Pick<PostgresDirectConversationRepository, 'withConversation'>,
    private readonly notifications: Pick<PostgresNotificationRepository, 'claimIntentOnClient'>,
    private readonly realtime: Pick<NotificationRealtimeService, 'publish'>,
    private readonly ownsPool = false) {}

  runOnce(): Promise<BatchResult> {
    if (this.stopped) return Promise.resolve({ processed: 0, failed: 0 });
    if (this.running) return this.running;
    const batch = this.drain(); this.running = batch;
    void batch.then(() => { if (this.running === batch) this.running = undefined; },
      () => { if (this.running === batch) this.running = undefined; });
    return batch;
  }

  onModuleInit() {
    const tick = () => { void this.runOnce().then(result => {
      if (result.failed) console.warn('Direct-message notification intents retained for retry');
    }).catch(() => console.warn('Direct-message notification queue is temporarily unavailable')); };
    this.timer = setInterval(tick, 1000); this.timer.unref?.(); tick();
  }

  async onModuleDestroy() {
    this.stopped = true; if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
    if (this.ownsPool) await this.pool.end();
  }

  private async drain(): Promise<BatchResult> {
    // Identifier candidates hold no locks. Current account→pair→conversation
    // serialization precedes any intent or notification lock on every replica.
    const candidates = (await this.pool.query<Candidate>(`SELECT conversation_id,recipient_user_id,generation
      FROM direct_message_notification_intents WHERE processed_generation < generation
        AND available_at <= clock_timestamp()
      ORDER BY available_at,updated_at,conversation_id,recipient_user_id LIMIT 20`)).rows;
    const result = { processed: 0, failed: 0 };
    for (const candidate of candidates) {
      let created: NotificationRecord | undefined;
      let attemptedGeneration = candidate.generation;
      try {
        await this.conversations.withConversation(candidate.recipient_user_id, candidate.conversation_id,
          async (client, room) => {
            const current = (await client.query<Candidate>(`SELECT conversation_id,recipient_user_id,generation
              FROM direct_message_notification_intents WHERE conversation_id=$1 AND recipient_user_id=$2
                AND processed_generation < generation AND available_at <= clock_timestamp() FOR UPDATE`,
            [room.id, candidate.recipient_user_id])).rows[0];
            if (!current) return;
            attemptedGeneration = current.generation;
            const lastRead = room.participant_a_id === candidate.recipient_user_id ? room.last_read_a : room.last_read_b;
            const first = (await client.query<{ id: string; created_at: Date }>(`SELECT id,created_at
              FROM direct_messages WHERE conversation_id=$1 AND sender_user_id<>$2 AND sequence>$3::bigint
              ORDER BY sequence LIMIT 1`, [room.id, candidate.recipient_user_id, lastRead])).rows[0];
            const disabled = (await client.query(`SELECT 1 FROM notification_preferences WHERE user_id=$1
              AND category='EXCHANGE' AND channel='IN_APP' AND NOT enabled`, [candidate.recipient_user_id])).rows.length > 0;
            if (first && !disabled) {
              const intent = directMessageNotificationIntent(room.id, candidate.recipient_user_id,
                { id: first.id, createdAt: first.created_at.toISOString() });
              const claim = await this.notifications.claimIntentOnClient(client, intent);
              if (claim.outcome === 'CONFLICT') throw new Error('Direct-message notification identity conflict');
              if (claim.outcome === 'CREATED') created = claim.record;
            }
            await client.query(`UPDATE direct_message_notification_intents SET processed_generation=$3::bigint,
              attempts=0 WHERE conversation_id=$1 AND recipient_user_id=$2 AND generation=$3::bigint`,
            [room.id, candidate.recipient_user_id, current.generation]);
          });
        result.processed++;
      } catch (error) {
        if (error instanceof MessageFailure && error.code === 'CONVERSATION_UNAVAILABLE') {
          // No payload was read. Compare the exact candidate generation so this
          // stale denial cannot acknowledge a later reconnect/send/read change.
          await this.pool.query(`UPDATE direct_message_notification_intents SET processed_generation=$3::bigint,
            attempts=0 WHERE conversation_id=$1 AND recipient_user_id=$2 AND generation=$3::bigint`,
          [candidate.conversation_id, candidate.recipient_user_id, candidate.generation]);
          result.processed++; continue;
        }
        await this.pool.query(`UPDATE direct_message_notification_intents
          SET attempts=LEAST(attempts+1,16), available_at=clock_timestamp()
            + make_interval(secs=>LEAST(300,5*power(2,LEAST(attempts,6)))::double precision)
          WHERE conversation_id=$1 AND recipient_user_id=$2 AND generation=$3::bigint
            AND processed_generation < generation`,
        [candidate.conversation_id, candidate.recipient_user_id, attemptedGeneration]);
        result.failed++; continue;
      }
      // withConversation commits first. Existing SSE projects current access;
      // canonical REST remains recoverable if this local hint fails.
      if (created) try { this.realtime.publish(created); }
      catch { console.warn('Direct-message notification live hint was unavailable'); }
    }
    return result;
  }
}
