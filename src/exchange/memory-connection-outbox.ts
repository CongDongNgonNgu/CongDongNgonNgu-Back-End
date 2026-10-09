import { randomUUID } from 'node:crypto';
import type { ExchangeConnectionMutationResult } from './exchange-connection.types';
import type { LeasedConnectionIntent } from './postgres-connection-outbox';

interface MemoryIntent {intent:LeasedConnectionIntent;availableAt:number;leasedUntil:number;handled:boolean;processing:boolean;}

export class MemoryConnectionOutbox {
  private readonly entries=new Map<string,MemoryIntent>();
  constructor(private readonly now:()=>number=Date.now) {}

  enqueue(actor:string,result:ExchangeConnectionMutationResult):void {
    if(!['REQUESTED','ACCEPTED','CONNECTED'].includes(result.outcome)) return;
    const record=result.record;
    if(!record || ![record.participantAId,record.participantBId].includes(actor)) throw new Error('Connection intent requires its participant record');
    const requested=result.outcome==='REQUESTED';
    const recipient=requested?(record.participantAId===actor?record.participantBId:record.participantAId):record.requesterId;
    if(actor===recipient) throw new Error('Connection intent cannot target its actor');
    const eventKind=requested?'REQUESTED':'CONNECTED';const key=`${record.id}:${eventKind}:${recipient}`;
    if(this.entries.has(key)) return;
    this.entries.set(key,{intent:{id:randomUUID(),connectionId:record.id,eventKind,actorId:actor,recipientId:recipient,
      participantAId:record.participantAId,participantBId:record.participantBId,
      occurredAt:new Date(requested?record.createdAt:record.updatedAt),attempts:0,leaseToken:''},
    availableAt:this.now(),leasedUntil:0,handled:false,processing:false});
  }

  async lease(limit=20):Promise<LeasedConnectionIntent[]> {
    if(!Number.isInteger(limit)||limit<1||limit>20) throw new Error('Connection outbox batch must be 1–20');
    const now=this.now();const token=randomUUID();
    const batch=[...this.entries.values()].filter(row=>!row.handled && !row.processing && row.availableAt<=now && row.leasedUntil<=now)
      .sort((a,b)=>a.availableAt-b.availableAt || a.intent.id.localeCompare(b.intent.id)).slice(0,limit);
    return batch.map(row=>{
      row.leasedUntil=now+30000;row.intent={...row.intent,attempts:Math.min(row.intent.attempts+1,1000000),leaseToken:token};
      return {...row.intent,occurredAt:new Date(row.intent.occurredAt)};
    });
  }

  async process(intent:LeasedConnectionIntent,materialize:(row:LeasedConnectionIntent)=>Promise<'DELIVERED'|'SUPPRESSED'>):Promise<void> {
    const row=[...this.entries.values()].find(entry=>entry.intent.id===intent.id);
    if(!row || row.handled || row.processing || row.intent.leaseToken!==intent.leaseToken || row.leasedUntil<=this.now()) return;
    row.processing=true;
    try {
      await materialize({...row.intent,occurredAt:new Date(row.intent.occurredAt)});
      if(row.intent.leaseToken===intent.leaseToken) {row.handled=true;row.leasedUntil=0;}
    } catch(error) {
      if(row.intent.leaseToken===intent.leaseToken) {
        row.leasedUntil=0;row.availableAt=this.now()+Math.min(300,5*2**Math.min(6,Math.max(0,intent.attempts-1)))*1000;
        row.intent={...row.intent,leaseToken:''};
      }
      throw error;
    } finally {row.processing=false;}
  }
}
