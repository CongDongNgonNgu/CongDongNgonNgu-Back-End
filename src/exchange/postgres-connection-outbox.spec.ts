import { describe,expect,it,jest } from '@jest/globals';
import type { Pool,PoolClient } from 'pg';
import { PostgresConnectionOutbox,type LeasedConnectionIntent } from './postgres-connection-outbox';

const INTENT:LeasedConnectionIntent={id:'00000000-0000-4000-8000-000000000020',
  connectionId:'00000000-0000-4000-8000-000000000010',eventKind:'REQUESTED',
  actorId:'00000000-0000-4000-8000-000000000001',recipientId:'00000000-0000-4000-8000-000000000002',
  participantAId:'00000000-0000-4000-8000-000000000001',participantBId:'00000000-0000-4000-8000-000000000002',
  occurredAt:new Date('2026-10-09T00:00:00.000Z'),attempts:1,leaseToken:'00000000-0000-4000-8000-000000000030'};
const ROW={id:INTENT.id,connection_id:INTENT.connectionId,event_kind:INTENT.eventKind,
  actor_id:INTENT.actorId,recipient_id:INTENT.recipientId,participant_a_id:INTENT.participantAId,
  participant_b_id:INTENT.participantBId,occurred_at:INTENT.occurredAt,attempts:1,lease_token:INTENT.leaseToken};

describe('leased connection intent processing',()=>{
  it('claims only a bounded batch with expired-lease recovery and skip-locked concurrency',async()=>{
    const query=jest.fn<(...args:unknown[])=>Promise<unknown>>().mockResolvedValue({rows:[ROW]});
    const queue=new PostgresConnectionOutbox({query} as unknown as Pool);
    expect(await queue.lease(5)).toEqual([INTENT]);
    expect(query).toHaveBeenCalledTimes(1);
    const sql=String(query.mock.calls[0][0]);
    expect(sql).toContain('SKIP LOCKED');expect(sql).toContain('leased_until<=clock_timestamp()');
    expect(query.mock.calls[0][1]).toEqual([5,expect.any(String)]);
    await expect(queue.lease(21)).rejects.toThrow();
  });

  it.each(['DELIVERED','SUPPRESSED'] as const)('materializes and marks %s in one account→pair→intent transaction',async status=>{
    const calls:string[]=[];
    const query=jest.fn(async(sql:string,_parameters?:unknown[])=>{calls.push(sql);return {rows:sql.includes('SELECT * FROM exchange_notification_outbox')?[ROW]:[]};});
    const client={query,release:jest.fn()} as unknown as PoolClient;
    const connect=jest.fn<()=>Promise<PoolClient>>().mockResolvedValue(client);
    const materialize=jest.fn(async(received:PoolClient,intent:LeasedConnectionIntent)=>{
      expect(received).toBe(client);expect(intent).toEqual(INTENT);calls.push('MATERIALIZE');return status;
    });
    await new PostgresConnectionOutbox({connect} as unknown as Pool).process(INTENT,materialize);
    expect(calls[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(calls.findIndex(sql=>sql.includes('FROM users'))).toBeLessThan(calls.findIndex(sql=>sql.includes('pg_advisory_xact_lock')));
    expect(calls.findIndex(sql=>sql.includes('pg_advisory_xact_lock'))).toBeLessThan(calls.indexOf('MATERIALIZE'));
    expect(calls.at(-1)).toBe('COMMIT');
    expect(query.mock.calls.find(call=>call[0].includes('SET status='))?.[1]).toEqual([INTENT.id,INTENT.leaseToken,status]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('does not invoke materialization for a stale or expired lease',async()=>{
    const client={query:jest.fn(async()=>({rows:[]})),release:jest.fn()} as unknown as PoolClient;
    const materialize=jest.fn<()=>Promise<'DELIVERED'>>().mockResolvedValue('DELIVERED');
    await new PostgresConnectionOutbox({connect:async()=>client} as unknown as Pool).process(INTENT,materialize);
    expect(materialize).not.toHaveBeenCalled();expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back materialization failure then releases only its own lease for bounded retry',async()=>{
    const client={query:jest.fn(async(sql:string)=>({rows:sql.includes('SELECT * FROM exchange_notification_outbox')?[ROW]:[]})),release:jest.fn()} as unknown as PoolClient;
    const retry=jest.fn(async(_sql:string,_parameters?:unknown[])=>({rows:[]}));
    const materialize=jest.fn<()=>Promise<'DELIVERED'>>().mockRejectedValue(new Error('Synthetic delivery failure'));
    await expect(new PostgresConnectionOutbox({connect:async()=>client,query:retry} as unknown as Pool).process(INTENT,materialize))
      .rejects.toThrow('Synthetic delivery failure');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(retry.mock.calls[0]?.[1]).toEqual([INTENT.id,INTENT.leaseToken,5]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
