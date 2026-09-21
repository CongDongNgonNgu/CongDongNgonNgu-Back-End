export const EXCHANGE_RELATIONSHIP_STATES = [
  'NONE',
  'OUTGOING_PENDING',
  'INCOMING_PENDING',
  'CONNECTED',
] as const;

export type ExchangeRelationshipState = typeof EXCHANGE_RELATIONSHIP_STATES[number];
export type ExchangeConnectionRecordStatus = 'PENDING' | 'CONNECTED';

export interface ExchangeConnectionRecord {
  id: string;
  participantAId: string;
  participantBId: string;
  requesterId: string;
  status: ExchangeConnectionRecordStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type ExchangeConnectionMutationOutcome =
  | 'NONE'
  | 'REQUESTED'
  | 'ALREADY_PENDING'
  | 'CONNECTED'
  | 'ALREADY_CONNECTED'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'DISCONNECTED'
  | 'SAFETY_BLOCKED'
  | 'SAFETY_REMOVED'
  | 'INVALID_ACTION';

export interface ExchangeConnectionMutationResult {
  record: ExchangeConnectionRecord | null;
  outcome: ExchangeConnectionMutationOutcome;
  connectionId?: string;
  requesterUserId?: string;
}

export interface ExchangeRelationshipResponse {
  scope: 'exchange-relationship';
  targetUserId: string;
  state: ExchangeRelationshipState;
  canRequest: boolean;
  canAccept: boolean;
  canDecline: boolean;
  canCancel: boolean;
  canDisconnect: boolean;
}

export type ExchangeConnectionEventType =
  | 'exchange.connection.requested'
  | 'exchange.connection.connected'
  | 'exchange.connection.declined'
  | 'exchange.connection.cancelled'
  | 'exchange.connection.disconnected'
  | 'exchange.connection.safety_removed';

export interface ExchangeConnectionEvent {
  type: ExchangeConnectionEventType;
  connectionId: string;
  actorUserId: string;
  targetUserId: string;
  requesterUserId: string;
  occurredAt: string;
}

export interface ExchangeConnectionEventSink {
  publish(event: ExchangeConnectionEvent): Promise<void>;
}
