import { ExchangeFailure } from './exchange.errors';
import type { ExchangeConnectionRecord, ExchangeRelationshipState } from './exchange-connection.types';
import type { ConnectionCursorCodec } from './connection-cursor-codec';

export type ConnectionListKind = 'INCOMING' | 'OUTGOING' | 'CONNECTED';
export interface ConnectionListInput { kind: ConnectionListKind; limit?: number; cursor?: string }
export interface ConnectionListItem {
  connectionId: string; targetUserId: string; state: ExchangeRelationshipState; updatedAt: string;
  displayName?: string;
}
export interface ConnectionListPage { items: ConnectionListItem[]; nextCursor: string | null }
export interface ConnectionListCursor { updatedAt: string; id: string }

export function connectionListQuery(actor: string, input: ConnectionListInput, codec?: ConnectionCursorCodec) {
  const limit = input.limit ?? 20;
  if (!['INCOMING','OUTGOING','CONNECTED'].includes(input.kind) || !Number.isInteger(limit) || limit<1 || limit>50) {
    throw new ExchangeFailure('EXCHANGE_INVALID_LIST_QUERY',400,'Connection list query is invalid');
  }
  let cursor: ConnectionListCursor | null = null;
  if (input.cursor !== undefined) {
    try {
      if (!codec) throw new Error();
      const value = codec.decode(input.cursor);
      if (!Array.isArray(value) || value.length!==5 || value[0]!==1 || value[1]!==actor || value[2]!==input.kind
        || typeof value[3]!=='string' || new Date(value[3]).toISOString()!==value[3]
        || typeof value[4]!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value[4])) throw new Error();
      cursor = {updatedAt:value[3],id:value[4]};
    } catch { throw new ExchangeFailure('EXCHANGE_INVALID_CURSOR',400,'Connection list cursor is invalid'); }
  }
  return {kind:input.kind,limit,cursor};
}

export function connectionListMatches(record: ExchangeConnectionRecord, actor: string, kind: ConnectionListKind) {
  if (record.participantAId!==actor && record.participantBId!==actor) return false;
  if (kind==='CONNECTED') return record.status==='CONNECTED';
  return record.status==='PENDING' && (kind==='OUTGOING' ? record.requesterId===actor : record.requesterId!==actor);
}

export function connectionListItem(record: ExchangeConnectionRecord, actor: string): ConnectionListItem {
  return {connectionId:record.id,targetUserId:record.participantAId===actor ? record.participantBId : record.participantAId,
    state:record.status==='CONNECTED' ? 'CONNECTED' : record.requesterId===actor ? 'OUTGOING_PENDING' : 'INCOMING_PENDING',
    updatedAt:record.updatedAt.toISOString()};
}

export function connectionListCursor(actor: string, kind: ConnectionListKind, record: ExchangeConnectionRecord, codec: ConnectionCursorCodec) {
  return codec.encode([1,actor,kind,record.updatedAt.toISOString(),record.id]);
}
