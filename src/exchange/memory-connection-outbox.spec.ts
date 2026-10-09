import { describe,expect,it } from '@jest/globals';
import { InMemoryExchangeConnectionRepository } from './exchange-connection.repository';
import { MemoryConnectionOutbox } from './memory-connection-outbox';
import type { ExchangeConnectionRecord } from './exchange-connection.types';

const A='00000000-0000-4000-8000-000000000001';const B='00000000-0000-4000-8000-000000000002';
const record:ExchangeConnectionRecord={id:'00000000-0000-4000-8000-000000000010',participantAId:A,participantBId:B,
  requesterId:A,status:'PENDING',createdAt:new Date('2026-10-09T00:00:00.000Z'),updatedAt:new Date('2026-10-09T00:00:01.000Z')};

describe('memory connection intent queue',()=>{
  it('deduplicates transition intents and chooses the canonical recipient',async()=>{
    const queue=new MemoryConnectionOutbox();queue.enqueue(A,{record,outcome:'REQUESTED'});queue.enqueue(A,{record,outcome:'REQUESTED'});
    queue.enqueue(A,{record,outcome:'ALREADY_PENDING'});queue.enqueue(B,{record:{...record,status:'CONNECTED'},outcome:'ACCEPTED'});
    const rows=await queue.lease();expect(rows).toHaveLength(2);
    expect(rows.find(row=>row.eventKind==='REQUESTED')).toMatchObject({actorId:A,recipientId:B,occurredAt:record.createdAt});
    expect(rows.find(row=>row.eventKind==='CONNECTED')).toMatchObject({actorId:B,recipientId:A,occurredAt:record.updatedAt});
    expect(await queue.lease()).toHaveLength(0);
  });
  it('retains failed delivery with bounded backoff and recovers expired leases',async()=>{
    let clock=0;const queue=new MemoryConnectionOutbox(()=>clock);queue.enqueue(A,{record,outcome:'REQUESTED'});
    const first=(await queue.lease())[0];
    await expect(queue.process(first,async()=>{throw new Error('Synthetic delivery failure');})).rejects.toThrow('Synthetic delivery failure');
    expect(await queue.lease()).toHaveLength(0);clock=5000;
    const retry=(await queue.lease())[0];expect(retry.attempts).toBe(2);
    clock+=30001;const recovered=(await queue.lease())[0];expect(recovered.attempts).toBe(3);
    let stale=false;await queue.process(retry,async()=>{stale=true;return 'DELIVERED';});expect(stale).toBe(false);
    await queue.process(recovered,async()=> 'SUPPRESSED');expect(await queue.lease()).toHaveLength(0);
  });
  it.each([false,true])('captures intents within connection mutations for crossed=%s',async crossed=>{
    const queue=new MemoryConnectionOutbox();
    const connections=new InMemoryExchangeConnectionRepository(undefined,undefined,Date.now,queue);
    await connections.requestConnection(A,B);await connections.requestConnection(A,B);
    if(crossed) await connections.requestConnection(B,A);else await connections.acceptConnection(B,A);
    await connections.acceptConnection(B,A);await connections.disconnect(A,B);
    const rows=await queue.lease();expect(rows).toHaveLength(2);
    expect(rows.find(row=>row.eventKind==='CONNECTED')).toMatchObject({actorId:B,recipientId:A});
    expect(await connections.findRelationship(A,B)).toBeNull();
  });
  it('excludes a materializing row from duplicate processing and expired-lease recovery',async()=>{
    let clock=0;const queue=new MemoryConnectionOutbox(()=>clock);queue.enqueue(A,{record,outcome:'REQUESTED'});
    const row=(await queue.lease())[0];let release!:()=>void;let started!:()=>void;let calls=0;
    const held=new Promise<void>(resolve=>{release=resolve;});const observed=new Promise<void>(resolve=>{started=resolve;});
    const one=queue.process(row,async()=>{calls++;started();await held;return 'DELIVERED';});await observed;
    await queue.process(row,async()=>{calls++;return 'DELIVERED';});expect(calls).toBe(1);
    clock=30001;expect(await queue.lease()).toHaveLength(0);
    release();await one;expect(await queue.lease()).toHaveLength(0);
  });
});
