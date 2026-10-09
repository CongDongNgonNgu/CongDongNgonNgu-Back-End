import type { PoolClient } from 'pg';
import type { PostgresNotificationRepository } from '../notifications/postgres-notification.repository';
import type { NotificationRecord } from '../notifications/notification.contracts';
import type { LeasedConnectionIntent } from './postgres-connection-outbox';
import { authorizeConnectionPair } from './exchange-pair-authorization';
import { ExchangeFailure } from './exchange.errors';
import { createNotificationIntent,hashNotificationIntent,normalizeNotificationActorProjection } from '../notifications/notification.contracts';
import { createNotificationDomainEvent,mapNotificationEvent } from '../notifications/notification-event-integration';

// Called only inside PostgresConnectionOutbox's account→pair transaction.
export async function materializeConnectionNotification(
  client:PoolClient,row:LeasedConnectionIntent,notifications:PostgresNotificationRepository,
  onCreated?:(record:NotificationRecord)=>void,
):Promise<'DELIVERED'|'SUPPRESSED'> {
  const users=(await client.query(`SELECT id,status,email_verified_at FROM users
    WHERE id IN ($1::uuid,$2::uuid) ORDER BY id`,[row.participantAId,row.participantBId])).rows;
  try {
    await authorizeConnectionPair(client,users,row.actorId,row.recipientId,true);
  } catch(error) {
    if(error instanceof ExchangeFailure && error.code==='EXCHANGE_PROFILE_UNAVAILABLE') return 'SUPPRESSED';
    throw error;
  }
  const blocked=await client.query(`SELECT 1 FROM language_exchange_blocks
    WHERE (blocker_user_id=$1::uuid AND blocked_user_id=$2::uuid)
       OR (blocker_user_id=$2::uuid AND blocked_user_id=$1::uuid)`,[row.actorId,row.recipientId]);
  if(blocked.rows.length) return 'SUPPRESSED';
  const relationship=(await client.query(`SELECT status,requester_id FROM language_exchange_connections
    WHERE id=$1::uuid AND participant_a_id=$2::uuid AND participant_b_id=$3::uuid`,
  [row.connectionId,row.participantAId,row.participantBId])).rows[0];
  if(!relationship || (row.eventKind==='REQUESTED'
    ? relationship.status!=='PENDING' || relationship.requester_id!==row.actorId
    : relationship.status!=='CONNECTED' || relationship.requester_id!==row.recipientId)) return 'SUPPRESSED';
  const preference=(await client.query(`SELECT enabled FROM notification_preferences
    WHERE user_id=$1::uuid AND category='EXCHANGE' AND channel='IN_APP'`,[row.recipientId])).rows[0];
  if(preference?.enabled===false) return 'SUPPRESSED';
  const intent=connectionNotificationIntent(row);
  const eventType=intent.sourceEvent.eventType;
  const claim=await notifications.claimIntentOnClient(client,intent,row.occurredAt);
  if(claim.outcome!=='CONFLICT') {
    if(claim.outcome==='CREATED') onCreated?.(claim.record);
    return 'DELIVERED';
  }
  // Strict reconciliation of the preceding synchronous request format. Other
  // fingerprint conflicts remain retryable failures rather than false delivery.
  if(row.eventKind==='REQUESTED') {
    const legacyEvent=createNotificationDomainEvent({eventId:row.connectionId,eventType,aggregateType:'EXCHANGE_CONNECTION',
      aggregateId:row.connectionId,actor:{kind:'USER',userId:row.actorId},recipientUserId:row.recipientId,
      occurredAt:row.occurredAt,idempotencyKey:intent.sourceEvent.idempotencyKey,
      target:{kind:'EXCHANGE_CONNECTION',id:row.connectionId,path:'/exchange'},variables:{relationship:'BUDDY_REQUEST'}});
    const legacyIntent=createNotificationIntent({event:legacyEvent,...mapNotificationEvent(legacyEvent),
      actor:{kind:'DELETED',label:'Deleted member'}});
    const legacy=await client.query(`SELECT actor,intent_fingerprint FROM notifications
      WHERE deduplication_key=$1 AND recipient_user_id=$2::uuid AND notification_type='BUDDY_REQUEST'
        AND source_event_id=$3::uuid AND source_event_type=$4 AND source_event_version=1
        AND source_aggregate_type='EXCHANGE_CONNECTION' AND source_aggregate_id=$3::uuid
        AND source_idempotency_key=$5 AND category='EXCHANGE' AND priority='NORMAL' AND created_at=$6::timestamptz
        AND target=$7::jsonb AND variables='{"relationship":"BUDDY_REQUEST"}'::jsonb
        AND source_payload_hash=$8 AND retention=$9::jsonb`,
    [intent.deduplicationKey,row.recipientId,row.connectionId,eventType,intent.sourceEvent.idempotencyKey,row.occurredAt,
      JSON.stringify(legacyIntent.target),legacyIntent.sourceEvent.payloadHash,JSON.stringify(legacyIntent.retention)]);
    if(legacy.rows[0]) {
      const actor=normalizeNotificationActorProjection(legacy.rows[0].actor);
      if((actor.kind==='DELETED' || (actor.kind==='USER' && actor.profilePath===`/profiles/${row.actorId}`))
        && hashNotificationIntent({...legacyIntent,actor})===legacy.rows[0].intent_fingerprint) return 'DELIVERED';
    }
  }
  throw new Error('Connection notification idempotency conflict');
}

export function connectionNotificationIntent(row:LeasedConnectionIntent) {
  const eventType=row.eventKind==='REQUESTED'?'exchange.connection.requested':'exchange.connection.connected';
  const event=createNotificationDomainEvent({eventId:row.connectionId,eventType,aggregateType:'EXCHANGE_CONNECTION',
    aggregateId:row.connectionId,actor:{kind:'USER',userId:row.actorId},recipientUserId:row.recipientId,
    occurredAt:row.occurredAt,idempotencyKey:`${eventType}:${row.connectionId}:v1`,
    target:{kind:'EXCHANGE_CONNECTION',id:row.connectionId,path:'/exchange/connections'},variables:{}});
  return createNotificationIntent({event,...mapNotificationEvent(event),actor:{kind:'DELETED',label:'Deleted member'}});
}
