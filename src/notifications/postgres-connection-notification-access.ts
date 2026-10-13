import { currentCommunityNotificationSource } from './community-notification-source';
import type { Pool } from 'pg';
import type { NotificationActorProjection,NotificationRecord } from './notification.contracts';
import type { NotificationRepository } from './notification.repository';
import type { ConnectionNotificationAccess } from './connection-notification-access';
import { isConnectionNotification } from './connection-notification-access';
import { authorizeConnectionPair,EXCHANGE_ELIGIBLE_PREFERENCE_PREDICATE,lockExchangeUsers } from '../exchange/exchange-pair-authorization';
import { lockExchangePair } from '../exchange/exchange-safety.repository';
import { ExchangeFailure } from '../exchange/exchange.errors';
import { PostgresDirectConversationRepository } from '../messaging/postgres-direct-conversation.repository';
import { MessageFailure } from '../messaging/message-failure';

const DIRECT_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class PostgresConnectionNotificationAccess implements ConnectionNotificationAccess {
  private readonly conversations:PostgresDirectConversationRepository;
  constructor(private readonly pool:Pool) {
    // Persistence-only dependency; importing MessagingModule would cycle through
    // CommunityModule back into NotificationModule.
    this.conversations=new PostgresDirectConversationRepository(pool);
  }
  async resolveCommunity(record:NotificationRecord,channel:'IN_APP'|'SSE'='IN_APP') {
    // Resolve by persisted notification identity and recipient, never its saved
    // actor name or route. Source IDs and current source-domain ACL decide.
    const row=(await this.pool.query(`SELECT current.* FROM notifications n
      CROSS JOIN LATERAL (${currentCommunityNotificationSource('n')}) current
      WHERE n.id=$1 AND n.recipient_user_id=$2
        AND NOT EXISTS (SELECT 1 FROM notification_preferences p WHERE p.user_id=n.recipient_user_id
          AND p.category=n.category AND p.channel='SSE' AND $3='SSE' AND NOT p.enabled)`,
      [record.id,record.recipientUserId,channel])).rows[0];
    return row?{actor:{kind:'USER' as const,displayName:String(row.display_name),profilePath:`/profiles/${row.actor_user_id}`},
      parentPostId:String(row.parent_post_id)}:null;
  }

  async resolve(record:NotificationRecord,channel:'IN_APP'|'SSE'='IN_APP'):Promise<NotificationActorProjection|null> {
    if(record.notificationType==='DIRECT_MESSAGE') return this.resolveDirectMessage(record,channel);
    if(!isConnectionNotification(record) || record.target?.kind!=='EXCHANGE_CONNECTION' || !record.target.id) return null;
    const pair=(await this.pool.query(`SELECT participant_a_id,participant_b_id FROM language_exchange_connections
      WHERE id::text=$1 AND (participant_a_id=$2::uuid OR participant_b_id=$2::uuid)`,[record.target.id,record.recipientUserId])).rows[0];
    if(!pair) return null;
    const actor=pair.participant_a_id===record.recipientUserId?pair.participant_b_id:pair.participant_a_id;
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const users=await lockExchangeUsers(client,pair.participant_a_id,pair.participant_b_id);
      await lockExchangePair(client,pair.participant_a_id,pair.participant_b_id);
      await authorizeConnectionPair(client,users,actor,record.recipientUserId,true);
      const row=(await client.query(`SELECT u.display_name FROM language_exchange_connections c JOIN users u ON u.id=$3::uuid
        WHERE c.id::text=$1 AND c.participant_a_id=$4::uuid AND c.participant_b_id=$5::uuid
          AND (($6='BUDDY_REQUEST' AND c.status='PENDING' AND c.requester_id=$3::uuid)
            OR ($6='BUDDY_CONNECTED' AND c.status='CONNECTED' AND c.requester_id=$2::uuid))
          AND NOT EXISTS (SELECT 1 FROM language_exchange_blocks b
            WHERE (b.blocker_user_id=$2::uuid AND b.blocked_user_id=$3::uuid)
              OR (b.blocker_user_id=$3::uuid AND b.blocked_user_id=$2::uuid))
          AND NOT EXISTS (SELECT 1 FROM notification_preferences p WHERE p.user_id=$2::uuid
            AND p.category='EXCHANGE' AND (p.channel='IN_APP' OR ($7='SSE' AND p.channel='SSE')) AND NOT p.enabled)`,
      [record.target.id,record.recipientUserId,actor,pair.participant_a_id,pair.participant_b_id,record.notificationType,channel])).rows[0];
      await client.query('COMMIT');
      return row?{kind:'USER',displayName:String(row.display_name),profilePath:`/profiles/${actor}`}:null;
    } catch(error) {
      await client.query('ROLLBACK').catch(()=>undefined);
      if(error instanceof ExchangeFailure && error.code==='EXCHANGE_PROFILE_UNAVAILABLE') return null;
      throw error;
    } finally {client.release();}
  }

  private async resolveDirectMessage(record:NotificationRecord,channel:'IN_APP'|'SSE'):Promise<NotificationActorProjection|null> {
    const id=record.target?.id;
    if(record.target?.kind!=='DIRECT_CONVERSATION' || !id || !DIRECT_ID.test(id)) return null;
    try {
      return await this.conversations.withConversation(record.recipientUserId,id,async(client,room)=>{
        const lastRead=room.participant_a_id===record.recipientUserId?room.last_read_a:room.last_read_b;
        // Do not filter by the source ID before LIMIT: a later unread message
        // must not make an obsolete coalesced episode available again.
        const first=(await client.query<{id:string}>(`SELECT m.id FROM direct_messages m
          WHERE m.conversation_id=$1 AND m.sender_user_id<>$2 AND m.sequence>$3::bigint
            AND NOT EXISTS(SELECT 1 FROM notification_preferences p WHERE p.user_id=$2
              AND p.category='EXCHANGE' AND (p.channel='IN_APP' OR ($4='SSE' AND p.channel='SSE')) AND NOT p.enabled)
          ORDER BY m.sequence LIMIT 1`,[id,record.recipientUserId,lastRead,channel])).rows[0];
        return first?.id===record.sourceEventId?{kind:'SYSTEM',label:'System'}:null;
      });
    } catch(error) {
      if(error instanceof MessageFailure && error.code==='CONVERSATION_UNAVAILABLE') return null;
      throw error;
    }
  }

  async countUnread(userId:string,_repository:NotificationRepository):Promise<number> {
    const result=await this.pool.query(`SELECT count(*)::int AS count
      FROM notification_read_states r JOIN notifications n ON n.id=r.notification_id AND n.recipient_user_id=r.recipient_user_id
      WHERE r.recipient_user_id=$1::uuid AND r.status='UNREAD' AND (
        n.notification_type NOT IN ('BUDDY_REQUEST','BUDDY_CONNECTED','DIRECT_MESSAGE','COMMENT_REPLY','ANSWER_ACCEPTED','CORRECTION_ACCEPTED')
        OR EXISTS (${currentCommunityNotificationSource('n')}) OR EXISTS (
          SELECT 1 FROM language_exchange_connections c WHERE c.id::text=n.target->>'id'
            AND n.target->>'kind'='EXCHANGE_CONNECTION'
            AND (c.participant_a_id=$1::uuid OR c.participant_b_id=$1::uuid)
            AND ((n.notification_type='BUDDY_REQUEST' AND c.status='PENDING' AND c.requester_id<>$1::uuid)
              OR (n.notification_type='BUDDY_CONNECTED' AND c.status='CONNECTED' AND c.requester_id=$1::uuid))
            AND NOT EXISTS (SELECT 1 FROM language_exchange_blocks b
              WHERE (b.blocker_user_id=c.participant_a_id AND b.blocked_user_id=c.participant_b_id)
                OR (b.blocker_user_id=c.participant_b_id AND b.blocked_user_id=c.participant_a_id))
            AND 2=(SELECT count(*) FROM users u WHERE u.id IN(c.participant_a_id,c.participant_b_id)
              AND u.status='ACTIVE' AND u.email_verified_at IS NOT NULL
              AND EXISTS(SELECT 1 FROM language_exchange_preferences p WHERE p.user_id=u.id
                AND ${EXCHANGE_ELIGIBLE_PREFERENCE_PREDICATE}))
            AND NOT EXISTS(SELECT 1 FROM notification_preferences p WHERE p.user_id=$1::uuid
              AND p.category='EXCHANGE' AND p.channel='IN_APP' AND NOT p.enabled)
        ) OR (n.notification_type='DIRECT_MESSAGE' AND n.target->>'kind'='DIRECT_CONVERSATION' AND EXISTS (
          SELECT 1 FROM direct_conversations d WHERE d.id::text=n.target->>'id'
            AND (d.participant_a_id=$1::uuid OR d.participant_b_id=$1::uuid)
            AND EXISTS(SELECT 1 FROM language_exchange_connections c
              WHERE c.participant_a_id=d.participant_a_id AND c.participant_b_id=d.participant_b_id
                AND c.status='CONNECTED')
            AND NOT EXISTS(SELECT 1 FROM language_exchange_blocks b
              WHERE (b.blocker_user_id=d.participant_a_id AND b.blocked_user_id=d.participant_b_id)
                OR (b.blocker_user_id=d.participant_b_id AND b.blocked_user_id=d.participant_a_id))
            AND 2=(SELECT count(*) FROM users u WHERE u.id IN(d.participant_a_id,d.participant_b_id)
              AND u.status='ACTIVE' AND u.email_verified_at IS NOT NULL
              AND EXISTS(SELECT 1 FROM language_exchange_preferences p WHERE p.user_id=u.id
                AND ${EXCHANGE_ELIGIBLE_PREFERENCE_PREDICATE} AND p.contact_permission<>'NO_CONTACT'))
            AND n.source_event_id=(SELECT m.id FROM direct_messages m
              WHERE m.conversation_id=d.id AND m.sender_user_id<>$1::uuid
                AND m.sequence>CASE WHEN d.participant_a_id=$1::uuid THEN d.last_read_a ELSE d.last_read_b END
              ORDER BY m.sequence LIMIT 1)
            AND NOT EXISTS(SELECT 1 FROM notification_preferences p WHERE p.user_id=$1::uuid
              AND p.category='EXCHANGE' AND p.channel='IN_APP' AND NOT p.enabled)
        )))`,[userId]);
    return Number(result.rows[0].count);
  }
}
