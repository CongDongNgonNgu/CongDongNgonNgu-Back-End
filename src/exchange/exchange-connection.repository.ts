import { randomUUID } from 'node:crypto';
import type {
  ExchangeConnectionMutationResult,
  ExchangeConnectionRecord,
} from './exchange-connection.types';
import type { ExchangeSafetyReadStore } from './exchange-safety.types';

export const EXCHANGE_CONNECTION_REPOSITORY = 'EXCHANGE_CONNECTION_REPOSITORY';

export interface ExchangeConnectionRepository {
  findRelationship(firstUserId: string, secondUserId: string): Promise<ExchangeConnectionRecord | null>;
  requestConnection(requesterUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult>;
  acceptConnection(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult>;
  declineConnection(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult>;
  cancelConnection(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult>;
  disconnect(actorUserId: string, targetUserId: string): Promise<ExchangeConnectionMutationResult>;
  removeRelationshipForSafety(firstUserId: string, secondUserId: string): Promise<ExchangeConnectionMutationResult>;
}

export class InMemoryExchangeConnectionRepository implements ExchangeConnectionRepository {
  private readonly relationships = new Map<string, ExchangeConnectionRecord>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly safety?: ExchangeSafetyReadStore) {}

  findRelationship(firstUserId: string, secondUserId: string): Promise<ExchangeConnectionRecord | null> {
    return this.withLock(async () => {
      if (await this.isBlocked(firstUserId, secondUserId)) return null;
      return cloneRecord(this.relationships.get(pairKey(firstUserId, secondUserId)) ?? null);
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
        this.relationships.set(key, record);
        return { record: cloneRecord(record), outcome: 'REQUESTED' as const };
      }
      if (current.status === 'CONNECTED') {
        return { record: cloneRecord(current), outcome: 'ALREADY_CONNECTED' as const };
      }
      if (current.requesterId === requesterUserId) {
        return { record: cloneRecord(current), outcome: 'ALREADY_PENDING' as const };
      }
      const connected = { ...current, status: 'CONNECTED' as const, updatedAt: new Date() };
      this.relationships.set(key, connected);
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
      if (!current) return { record: null, outcome: 'NONE' as const };
      if (current.status === 'CONNECTED') {
        return { record: cloneRecord(current), outcome: 'ALREADY_CONNECTED' as const };
      }
      if (current.requesterId === actorUserId) {
        return { record: cloneRecord(current), outcome: 'INVALID_ACTION' as const };
      }
      const connected = { ...current, status: 'CONNECTED' as const, updatedAt: new Date() };
      this.relationships.set(key, connected);
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
