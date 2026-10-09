import { randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { lockExchangeUsers } from './exchange-pair-authorization';
import { lockExchangePair } from './exchange-safety.repository';

export interface LeasedConnectionIntent {
  id:string;
  connectionId:string;
  eventKind:'REQUESTED'|'CONNECTED';
  actorId:string;
  recipientId:string;
  participantAId:string;
  participantBId:string;
  occurredAt:Date;
  attempts:number;
  leaseToken:string;
}

export class PostgresConnectionOutbox {
  constructor(private readonly pool:Pool) {}

  async lease(limit=20):Promise<LeasedConnectionIntent[]> {
    if (!Number.isInteger(limit) || limit<1 || limit>20) throw new Error('Connection outbox batch must be 1–20');
    const result=await this.pool.query(`WITH candidates AS (
      SELECT id FROM exchange_notification_outbox
      WHERE status='PENDING' AND available_at<=clock_timestamp()
        AND (leased_until IS NULL OR leased_until<=clock_timestamp())
      ORDER BY available_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE exchange_notification_outbox o SET lease_token=$2::uuid,
      leased_until=clock_timestamp()+interval '30 seconds',attempts=LEAST(o.attempts+1,1000000)
      FROM candidates c WHERE o.id=c.id RETURNING o.*`,[limit,randomUUID()]);
    return result.rows.map(mapIntent);
  }

  async process(intent:LeasedConnectionIntent,
    materialize:(client:PoolClient,intent:LeasedConnectionIntent)=>Promise<'DELIVERED'|'SUPPRESSED'>,
  ):Promise<void> {
    const client=await this.pool.connect();
    let failed=false;let failure:unknown;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await lockExchangeUsers(client,intent.participantAId,intent.participantBId);
      await lockExchangePair(client,intent.participantAId,intent.participantBId);
      const current=await client.query(`SELECT * FROM exchange_notification_outbox
        WHERE id=$1::uuid AND lease_token=$2::uuid AND status='PENDING'
          AND leased_until>clock_timestamp() FOR UPDATE`,[intent.id,intent.leaseToken]);
      if (current.rows[0]) {
        // Materializer rechecks current pair eligibility/preferences on this client.
        const status=await materialize(client,mapIntent(current.rows[0]));
        await client.query(`UPDATE exchange_notification_outbox SET status=$3,handled_at=clock_timestamp(),
          lease_token=NULL,leased_until=NULL WHERE id=$1::uuid AND lease_token=$2::uuid`,
        [intent.id,intent.leaseToken,status]);
      }
      await client.query('COMMIT');
    } catch(error) {
      failed=true;failure=error;
      await client.query('ROLLBACK').catch(()=>undefined);
    } finally { client.release(); }
    if (failed) {
      // Release the transaction client before an own-pool retry update (max=1 safe).
      const delay=Math.min(300,5*2**Math.min(6,Math.max(0,intent.attempts-1)));
      await this.pool.query(`UPDATE exchange_notification_outbox SET lease_token=NULL,leased_until=NULL,
        available_at=clock_timestamp()+$3::int*interval '1 second'
        WHERE id=$1::uuid AND lease_token=$2::uuid AND status='PENDING'`,
      [intent.id,intent.leaseToken,delay]).catch(()=>undefined);
      throw failure;
    }
  }
}

function mapIntent(row:Record<string,unknown>):LeasedConnectionIntent {
  return {id:String(row.id),connectionId:String(row.connection_id),eventKind:row.event_kind as LeasedConnectionIntent['eventKind'],
    actorId:String(row.actor_id),recipientId:String(row.recipient_id),participantAId:String(row.participant_a_id),
    participantBId:String(row.participant_b_id),occurredAt:new Date(row.occurred_at as string|Date),
    attempts:Number(row.attempts),leaseToken:String(row.lease_token)};
}
