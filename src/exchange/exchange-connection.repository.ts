import { randomUUID } from 'node:crypto';
import type {
  ExchangeConnectionMutationResult,
  ExchangeConnectionRecord,
} from './exchange-connection.types';
import type { ExchangeSafetyReadStore } from './exchange-safety.types';
import { ConnectionCursorCodec } from './connection-cursor-codec';
import { ExchangeFailure } from './exchange.errors';
import type { MemoryConnectionOutbox } from './memory-connection-outbox';
import { connectionListQuery, connectionListMatches, connectionListItem, connectionListCursor,
  type ConnectionListInput, type ConnectionListPage } from './exchange-connection-list';

export const EXCHANGE_CONNECTION_REPOSITORY = 'EXCHANGE_CONNECTION_REPOSITORY';

export interface ExchangeConnectionRepository {
  listRelationships(actor: string, input: ConnectionListInput): Promise<ConnectionListPage>;
  findRelationship(firstUserId: string, secondUserId: string): Promise<ExchangeConnectionRecord | null>;
  requestConnection(requesterUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult>;
  acceptConnection(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult>;
  declineConnection(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult>;
  cancelConnection(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult>;
  disconnect(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult>;
  removeRelationshipForSafety(firstUserId: string, secondUserId: string): Promise<ExchangeConnectionMutationResult>;
}

export class InMemoryExchangeConnectionRepository implements ExchangeConnectionRepository {
  private mutationRevision=0;
  get revision():number {return this.mutationRevision+(this.safety?.revision??0);}
  private readonly relationships = new Map<string, ExchangeConnectionRecord>();
  private operationTail: Promise<void> = Promise.resolve();
  private readonly pairResetAt = new Map<string,number>();

  constructor(private readonly safety?: ExchangeSafetyReadStore, private readonly cursors = new ConnectionCursorCodec(),
    private readonly now:()=>number=Date.now,private readonly outbox?:MemoryConnectionOutbox) {}

  listRelationships(actor: string, input: ConnectionListInput): Promise<ConnectionListPage> {
    return this.withLock(async () => {
      const query = connectionListQuery(actor,input,this.cursors);
      const records = [...this.relationships.values()].filter(record => connectionListMatches(record,actor,query.kind))
        .sort((a,b) => b.updatedAt.getTime()-a.updatedAt.getTime() || b.id.localeCompare(a.id));
      const visible: ExchangeConnectionRecord[] = [];
      for (const record of records) {
        if (query.cursor && (record.updatedAt.toISOString()>query.cursor.updatedAt
          || (record.updatedAt.toISOString()===query.cursor.updatedAt && record.id>=query.cursor.id))) continue;
        const target = record.participantAId===actor ? record.participantBId : record.participantAId;
        if (!await this.isBlocked(actor,target)) visible.push(record);
        if (visible.length>query.limit) break;
      }
      const page = visible.slice(0,query.limit);
      return {items:page.map(record => connectionListItem(record,actor)),nextCursor:visible.length>query.limit
        ? connectionListCursor(actor,query.kind,page[page.length-1],this.cursors) : null};
    });
  }

  findRelationship(firstUserId: string, secondUserId: string): Promise<ExchangeConnectionRecord | null> {
    return this.withLock(async () => {
      if (await this.isBlocked(firstUserId, secondUserId)) return null;
      return cloneRecord(this.relationships.get(pairKey(firstUserId, secondUserId)) ?? null);
    });
  }

  findRelationshipById(userId:string,id:string):Promise<ExchangeConnectionRecord|null> {
    return this.withLock(async()=>{
      const record=[...this.relationships.values()].find(item=>item.id===id
        && (item.participantAId===userId || item.participantBId===userId));
      if(!record || await this.isBlocked(record.participantAId,record.participantBId)) return null;
      return cloneRecord(record);
    });
  }

  requestConnection(
    requesterUserId: string,
    targetUserId: string,
  ): Promise<ExchangeConnectionMutationResult> {
    return this.withLock(async () => {
      if (await this.isBlocked(requesterUserId, targetUserId)) {
        return { record: null, outcome: 'SAFETY_BLOCKED' as const };
      }
      const key = pairKey(requesterUserId, targetUserId);
      const current = this.relationships.get(key);
      if (!current) {
        const clock=this.now();const resetAt=this.pairResetAt.get(key) ?? 0;
        if(resetAt>clock) throw new ExchangeFailure('EXCHANGE_RATE_LIMITED',429,'Too many Exchange actions',Math.ceil((resetAt-clock)/1000));
        const now = new Date();
        const [participantAId, participantBId] = canonicalPair(requesterUserId, targetUserId);
        const record: ExchangeConnectionRecord = {
          id: randomUUID(),
          participantAId,
          participantBId,
          requesterId: requesterUserId,
          status: 'PENDING',
          createdAt: now,
          updatedAt: now,
        };
        this.outbox?.enqueue(requesterUserId,{record,outcome:'REQUESTED'});
        this.relationships.set(key, record);
        this.mutationRevision+=1;
        this.pairResetAt.set(key,clock+60000);
        return { record: cloneRecord(record), outcome: 'REQUESTED' as const };
      }
      if (current.status === 'CONNECTED') {
        return { record: cloneRecord(current), outcome: 'ALREADY_CONNECTED' as const };
      }
      if (current.requesterId === requesterUserId) {
        return { record: cloneRecord(current), outcome: 'ALREADY_PENDING' as const };
      }
      const connected = { ...current, status: 'CONNECTED' as const, updatedAt: new Date() };
      this.outbox?.enqueue(requesterUserId,{record:connected,outcome:'CONNECTED'});
      this.relationships.set(key, connected);
      this.mutationRevision+=1;
      return { record: cloneRecord(connected), outcome: 'CONNECTED' as const };
    });
  }

  acceptConnection(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult> {
    return this.withLock(async () => {
      if (await this.isBlocked(actorUserId, targetUserId)) {
        return { record: null, outcome: 'SAFETY_BLOCKED' as const };
      }
      const key = pairKey(actorUserId, targetUserId);
      const current = this.relationships.get(key);
      if (!current) return { record: null, outcome: 'INVALID_ACTION' as const };
      if (current.status === 'CONNECTED') {
        return { record: cloneRecord(current), outcome: 'ALREADY_CONNECTED' as const };
      }
      if (current.requesterId === actorUserId) {
        return { record: cloneRecord(current), outcome: 'INVALID_ACTION' as const };
      }
      const connected = { ...current, status: 'CONNECTED' as const, updatedAt: new Date() };
      this.outbox?.enqueue(actorUserId,{record:connected,outcome:'ACCEPTED'});
      this.relationships.set(key, connected);
      this.mutationRevision+=1;
      return { record: cloneRecord(connected), outcome: 'ACCEPTED' as const };
    });
  }

  declineConnection(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult> {
    return this.withLock(async () => {
      if (await this.isBlocked(actorUserId, targetUserId)) {
        return { record: null, outcome: 'SAFETY_BLOCKED' as const };
      }
      return this.deletePending(actorUserId, targetUserId, 'DECLINED');
    });
  }

  cancelConnection(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult> {
    return this.withLock(async () => {
      if (await this.isBlocked(actorUserId, targetUserId)) {
        return { record: null, outcome: 'SAFETY_BLOCKED' as const };
      }
      const key = pairKey(actorUserId, targetUserId);
      const current = this.relationships.get(key);
      if (!current) return { record: null, outcome: 'NONE' as const };
      if (current.status !== 'PENDING' || current.requesterId !== actorUserId) {
        return { record: cloneRecord(current), outcome: 'INVALID_ACTION' as const };
      }
      this.relationships.delete(key);
      this.mutationRevision+=1;
      return { record: null, connectionId: current.id, requesterUserId: current.requesterId, outcome: 'CANCELLED' as const };
    });
  }

  disconnect(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult> {
    return this.withLock(async () => {
      if (await this.isBlocked(actorUserId, targetUserId)) {
        return { record: null, outcome: 'SAFETY_BLOCKED' as const };
      }
      const key = pairKey(actorUserId, targetUserId);
      const current = this.relationships.get(key);
      if (!current) return { record: null, outcome: 'NONE' as const };
      if (current.status !== 'CONNECTED') {
        return { record: cloneRecord(current), outcome: 'INVALID_ACTION' as const };
      }
      this.relationships.delete(key);
      this.mutationRevision+=1;
      return { record: null, connectionId: current.id, requesterUserId: current.requesterId, outcome: 'DISCONNECTED' as const };
    });
  }

  removeRelationshipForSafety(
    firstUserId: string,
    secondUserId: string,
  ): Promise<ExchangeConnectionMutationResult> {
    return this.withLock(() => {
      const key = pairKey(firstUserId, secondUserId);
      const current = this.relationships.get(key);
      if (!current) return { record: null, outcome: 'NONE' as const };
      this.relationships.delete(key);
      this.mutationRevision+=1;
      return {
        record: null,
        connectionId: current.id,
        requesterUserId: current.requesterId,
        outcome: 'SAFETY_REMOVED' as const,
      };
    });
  }

  private deletePending(
    actorUserId: string,
    targetUserId: string,
    outcome: 'DECLINED',
  ): ExchangeConnectionMutationResult {
    const key = pairKey(actorUserId, targetUserId);
    const current = this.relationships.get(key);
    if (!current) return { record: null, outcome: 'NONE' };
    if (current.status !== 'PENDING' || current.requesterId === actorUserId) {
      return { record: cloneRecord(current), outcome: 'INVALID_ACTION' };
    }
    this.relationships.delete(key);
    this.mutationRevision+=1;
    return { record: null, connectionId: current.id, requesterUserId: current.requesterId, outcome };
  }

  private withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async isBlocked(firstUserId: string, secondUserId: string): Promise<boolean> {
    return this.safety ? this.safety.isBlocked(firstUserId, secondUserId) : false;
  }
}

function canonicalPair(firstUserId: string, secondUserId: string): [string, string] {
  return firstUserId < secondUserId
    ? [firstUserId, secondUserId]
    : [secondUserId, firstUserId];
}

function pairKey(firstUserId: string, secondUserId: string): string {
  return canonicalPair(firstUserId, secondUserId).join(':');
}

function cloneRecord(record: ExchangeConnectionRecord | null): ExchangeConnectionRecord | null {
  if (!record) return null;
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}
