import type { PoolClient } from 'pg';
import type { ExchangeConnectionMutationResult } from './exchange-connection.types';

export async function enqueueConnectionNotification(
  client: PoolClient, actorId: string, result: ExchangeConnectionMutationResult,
): Promise<void> {
  if (!['REQUESTED','ACCEPTED','CONNECTED'].includes(result.outcome)) return;
  const record=result.record;
  if (!record || ![record.participantAId,record.participantBId].includes(actorId)) {
    throw new Error('Connection notification requires its authoritative participant record');
  }
  const requested=result.outcome==='REQUESTED';
  const recipientId=requested
    ? (actorId===record.participantAId?record.participantBId:record.participantAId)
    : record.requesterId;
  if (actorId===recipientId) throw new Error('Connection notification cannot target its actor');
  await client.query(`INSERT INTO exchange_notification_outbox (
    connection_id,event_kind,actor_id,recipient_id,participant_a_id,participant_b_id,occurred_at
  ) VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::timestamptz)
  ON CONFLICT(connection_id,event_kind,recipient_id) DO NOTHING`,
  [record.id,requested?'REQUESTED':'CONNECTED',actorId,recipientId,
    record.participantAId,record.participantBId,requested?record.createdAt:record.updatedAt]);
}
