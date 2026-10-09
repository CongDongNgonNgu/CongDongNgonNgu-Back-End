import type { Pool } from 'pg';
import type { NotificationActorProjection,NotificationRecord } from './notification.contracts';
import type { NotificationRepository } from './notification.repository';
import type { ConnectionNotificationAccess } from './connection-notification-access';
import { isConnectionNotification } from './connection-notification-access';
import { authorizeConnectionPair,EXCHANGE_ELIGIBLE_PREFERENCE_PREDICATE,lockExchangeUsers } from '../exchange/exchange-pair-authorization';
import { lockExchangePair } from '../exchange/exchange-safety.repository';
import { ExchangeFailure } from '../exchange/exchange.errors';

export class PostgresConnectionNotificationAccess implements ConnectionNotificationAccess {
  constructor(private readonly pool:Pool) {}
  async resolve(record:NotificationRecord,channel:'IN_APP'|'SSE'='IN_APP'):Promise<NotificationActorProjection|null> {
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

  async countUnread(userId:string,_repository:NotificationRepository):Promise<number> {
    const result=await this.pool.query(`SELECT count(*)::int AS count
      FROM notification_read_states r JOIN notifications n ON n.id=r.notification_id AND n.recipient_user_id=r.recipient_user_id
      WHERE r.recipient_user_id=$1::uuid AND r.status='UNREAD' AND (
        n.notification_type NOT IN ('BUDDY_REQUEST','BUDDY_CONNECTED') OR EXISTS (
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
        ))`,[userId]);
    return Number(result.rows[0].count);
  }
}
