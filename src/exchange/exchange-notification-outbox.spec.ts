import { describe, expect, it, jest } from '@jest/globals';
import type { PoolClient } from 'pg';
import { enqueueConnectionNotification } from './exchange-notification-outbox';
import type { ExchangeConnectionMutationOutcome, ExchangeConnectionRecord } from './exchange-connection.types';

const A='00000000-0000-4000-8000-000000000001';
const B='00000000-0000-4000-8000-000000000002';
const RECORD:ExchangeConnectionRecord={id:'00000000-0000-4000-8000-000000000010',
  participantAId:A,participantBId:B,requesterId:A,status:'PENDING',
  createdAt:new Date('2026-09-18T00:00:00Z'),updatedAt:new Date('2026-10-09T00:00:00Z')};

describe('durable connection notification intents',()=>{
  it.each(['REQUESTED','ACCEPTED','CONNECTED'] as const)('queues %s on the supplied transaction with only identifiers and occurrence time',async outcome=>{
    const query=jest.fn<(...args:unknown[])=>Promise<unknown>>().mockResolvedValue({rows:[]});
    const client={query,release:jest.fn()} as unknown as PoolClient;
    const actor=outcome==='REQUESTED'?A:B;
    await enqueueConnectionNotification(client,actor,{outcome,record:{...RECORD,status:outcome==='REQUESTED'?'PENDING':'CONNECTED'}});
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toEqual(expect.stringContaining('INSERT INTO exchange_notification_outbox'));
    expect(query.mock.calls[0][0]).toEqual(expect.stringContaining('ON CONFLICT'));
    expect(query.mock.calls[0][1]).toEqual([RECORD.id,outcome==='REQUESTED'?'REQUESTED':'CONNECTED',actor,
      outcome==='REQUESTED'?B:A,A,B,outcome==='REQUESTED'?RECORD.createdAt:RECORD.updatedAt]);
    expect(client.release).not.toHaveBeenCalled();
  });

  it.each(['ALREADY_PENDING','ALREADY_CONNECTED','NONE','INVALID_ACTION','DECLINED','CANCELLED','DISCONNECTED','SAFETY_BLOCKED','SAFETY_REMOVED'] as ExchangeConnectionMutationOutcome[])
    ('does not enqueue %s',async outcome=>{
      const query=jest.fn();
      await enqueueConnectionNotification({query} as unknown as PoolClient,A,{outcome,record:RECORD});
      expect(query).not.toHaveBeenCalled();
    });

  it('propagates persistence failure to the transaction owner',async()=>{
    const query=jest.fn<(...args:unknown[])=>Promise<unknown>>().mockRejectedValue(new Error('Synthetic outbox failure'));
    await expect(enqueueConnectionNotification({query} as unknown as PoolClient,A,{outcome:'REQUESTED',record:RECORD}))
      .rejects.toThrow('Synthetic outbox failure');
  });
});
