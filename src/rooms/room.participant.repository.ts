import { randomUUID } from 'node:crypto';
import type { SpeakingRoomLifecycle, SpeakingRoomParticipantRole } from './room.types';
import type {
  SpeakingRoomParticipantAction,
  SpeakingRoomParticipantCounts,
  SpeakingRoomParticipantRecord,
  SpeakingRoomParticipantState,
} from './room.participant.types';

export const SPEAKING_ROOM_PARTICIPANT_REPOSITORY = 'SPEAKING_ROOM_PARTICIPANT_REPOSITORY';

export const PARTICIPANT_DISCONNECT_AFTER_MS = 30_000;
export const PARTICIPANT_RECONNECT_LEASE_MS = 90_000;

export interface JoinSpeakingRoomParticipantInput {
  roomId: string;
  userId: string;
  deviceId: string;
  joinRequestId: string;
  participantId: string | null;
  role: SpeakingRoomParticipantRole;
  capacity: number;
  lifecycle: SpeakingRoomLifecycle;
  now: Date;
}

export interface LeaveSpeakingRoomParticipantInput {
  roomId: string;
  userId: string;
  participantId: string;
  requestId: string;
  mode: 'VOLUNTARY' | 'DISCONNECT';
  now: Date;
}

export interface HeartbeatSpeakingRoomParticipantInput {
  roomId: string;
  userId: string;
  participantId: string;
  requestId: string;
  now: Date;
}

export interface SpeakingRoomParticipantMutationResult {
  participant: SpeakingRoomParticipantRecord;
  replayed: boolean;
}

export interface SpeakingRoomParticipantReconciliationResult {
  disconnected: number;
  left: number;
}

export class SpeakingRoomParticipantNotFoundError extends Error {
  constructor(message = 'Speaking room participant was not found') {
    super(message);
    this.name = 'SpeakingRoomParticipantNotFoundError';
  }
}

export type SpeakingRoomParticipantConflictReason =
  | 'CAPACITY'
  | 'REQUEST_REUSED'
  | 'INVALID_STATE'
  | 'DEVICE_CONFLICT'
  | 'ROOM_NOT_JOINABLE';

export class SpeakingRoomParticipantConflictError extends Error {
  constructor(
    readonly reason: SpeakingRoomParticipantConflictReason,
    message = 'Speaking room participant conflicts with existing state',
  ) {
    super(message);
    this.name = 'SpeakingRoomParticipantConflictError';
  }
}

export interface SpeakingRoomParticipantRepository {
  joinParticipant(input: JoinSpeakingRoomParticipantInput): Promise<SpeakingRoomParticipantMutationResult>;
  leaveParticipant(input: LeaveSpeakingRoomParticipantInput): Promise<SpeakingRoomParticipantMutationResult>;
  heartbeatParticipant(input: HeartbeatSpeakingRoomParticipantInput): Promise<SpeakingRoomParticipantMutationResult>;
  reconcileStaleParticipants(
    roomId: string,
    now: Date,
  ): Promise<SpeakingRoomParticipantReconciliationResult>;
  listParticipants(roomId: string, now: Date): Promise<SpeakingRoomParticipantRecord[]>;
  countParticipants(roomId: string, now: Date): Promise<SpeakingRoomParticipantCounts>;
  findActiveParticipant(
    roomId: string,
    userId: string,
    now: Date,
  ): Promise<SpeakingRoomParticipantRecord | null>;
  findParticipant(
    roomId: string,
    participantId: string,
    now: Date,
  ): Promise<SpeakingRoomParticipantRecord | null>;
  setParticipantRole(
    roomId: string,
    participantId: string,
    role: SpeakingRoomParticipantRole,
    now: Date,
  ): Promise<SpeakingRoomParticipantRecord>;
  removeParticipant(
    roomId: string,
    participantId: string,
    now: Date,
  ): Promise<SpeakingRoomParticipantRecord>;
}

interface RecordedAction {
  participantId: string;
  action: SpeakingRoomParticipantAction;
  state: SpeakingRoomParticipantState;
}

/** Deterministic test adapter; production wiring uses the Postgres repository. */
export class InMemorySpeakingRoomParticipantRepository implements SpeakingRoomParticipantRepository {
  private readonly participants = new Map<string, SpeakingRoomParticipantRecord>();
  private readonly joinRequests = new Map<string, string>();
  private readonly actions = new Map<string, RecordedAction>();
  private writeTail: Promise<void> = Promise.resolve();

  async joinParticipant(input: JoinSpeakingRoomParticipantInput): Promise<SpeakingRoomParticipantMutationResult> {
    return this.exclusive(() => {
      if (input.lifecycle !== 'LIVE') {
        throw new SpeakingRoomParticipantConflictError('ROOM_NOT_JOINABLE', 'Room is not live');
      }
      this.reconcileRoom(input.roomId, input.now);
      const actionKeyValue = actionKey(input.roomId, input.userId, input.joinRequestId);
      const recorded = this.actions.get(actionKeyValue);
      if (recorded) {
        if (recorded.action !== 'JOIN') {
          throw new SpeakingRoomParticipantConflictError('REQUEST_REUSED', 'Request id was already used');
        }
        return this.result(recorded.participantId, true);
      }

      const requested = this.findByJoinRequest(input.roomId, input.userId, input.joinRequestId);
      if (requested) return this.result(requested.id, true);

      const reconnect = input.participantId
        ? this.participants.get(input.participantId)
        : undefined;
      if (input.participantId && (!reconnect || reconnect.roomId !== input.roomId || reconnect.userId !== input.userId)) {
        throw new SpeakingRoomParticipantNotFoundError();
      }
      if (reconnect) {
        if (!isActiveState(reconnect.state)) {
          throw new SpeakingRoomParticipantConflictError('INVALID_STATE', 'Participant lease is no longer active');
        }
        const deviceConflict = this.findActiveByDevice(input.roomId, input.userId, input.deviceId, reconnect.id);
        if (deviceConflict) {
          throw new SpeakingRoomParticipantConflictError('DEVICE_CONFLICT', 'Device already has an active participant');
        }
        this.markPresent(reconnect, input);
        this.recordAction(actionKeyValue, reconnect, 'JOIN');
        return this.result(reconnect.id, false);
      }

      const sameDevice = this.findActiveByDevice(input.roomId, input.userId, input.deviceId);
      if (sameDevice) {
        this.markPresent(sameDevice, input);
        this.recordAction(actionKeyValue, sameDevice, 'JOIN');
        return this.result(sameDevice.id, false);
      }

      if (this.activeCount(input.roomId) >= input.capacity) {
        throw new SpeakingRoomParticipantConflictError('CAPACITY', 'Room capacity has been reached');
      }
      const participant: SpeakingRoomParticipantRecord = {
        id: randomUUID(),
        roomId: input.roomId,
        userId: input.userId,
        deviceId: input.deviceId,
        joinRequestId: input.joinRequestId,
        role: input.role,
        state: 'PRESENT',
        joinedAt: new Date(input.now),
        lastSeenAt: new Date(input.now),
        disconnectedAt: null,
        leftAt: null,
        updatedAt: new Date(input.now),
      };
      this.participants.set(participant.id, participant);
      this.joinRequests.set(joinKey(input.roomId, input.userId, input.joinRequestId), participant.id);
      this.recordAction(actionKeyValue, participant, 'JOIN');
      return this.result(participant.id, false);
    });
  }

  async leaveParticipant(input: LeaveSpeakingRoomParticipantInput): Promise<SpeakingRoomParticipantMutationResult> {
    return this.exclusive(() => {
      this.reconcileRoom(input.roomId, input.now);
      const actionKeyValue = actionKey(input.roomId, input.userId, input.requestId);
      const recorded = this.actions.get(actionKeyValue);
      const expectedAction = input.mode === 'DISCONNECT' ? 'DISCONNECT' : 'LEAVE';
      if (recorded) {
        if (recorded.action !== expectedAction) {
          throw new SpeakingRoomParticipantConflictError('REQUEST_REUSED', 'Request id was already used');
        }
        return this.result(recorded.participantId, true);
      }
      const participant = this.findOwned(input.roomId, input.userId, input.participantId);
      if (!participant) throw new SpeakingRoomParticipantNotFoundError();
      if (input.mode === 'DISCONNECT') {
        if (participant.state === 'PRESENT') {
          participant.state = 'DISCONNECTED';
          participant.disconnectedAt = new Date(input.now);
          participant.updatedAt = new Date(input.now);
        }
        this.recordAction(actionKeyValue, participant, 'DISCONNECT');
      } else {
        if (participant.state === 'PRESENT' || participant.state === 'DISCONNECTED') {
          participant.state = 'LEFT';
          participant.leftAt = new Date(input.now);
          participant.updatedAt = new Date(input.now);
        }
        this.recordAction(actionKeyValue, participant, 'LEAVE');
      }
      return this.result(participant.id, false);
    });
  }

  async heartbeatParticipant(input: HeartbeatSpeakingRoomParticipantInput): Promise<SpeakingRoomParticipantMutationResult> {
    return this.exclusive(() => {
      this.reconcileRoom(input.roomId, input.now);
      const actionKeyValue = actionKey(input.roomId, input.userId, input.requestId);
      const recorded = this.actions.get(actionKeyValue);
      if (recorded) {
        if (recorded.action !== 'HEARTBEAT') {
          throw new SpeakingRoomParticipantConflictError('REQUEST_REUSED', 'Request id was already used');
        }
        return this.result(recorded.participantId, true);
      }
      const participant = this.findOwned(input.roomId, input.userId, input.participantId);
      if (!participant || !isActiveState(participant.state)) {
        throw new SpeakingRoomParticipantNotFoundError();
      }
      participant.state = 'PRESENT';
      participant.lastSeenAt = new Date(input.now);
      participant.disconnectedAt = null;
      participant.updatedAt = new Date(input.now);
      this.recordAction(actionKeyValue, participant, 'HEARTBEAT');
      return this.result(participant.id, false);
    });
  }

  async reconcileStaleParticipants(
    roomId: string,
    now: Date,
  ): Promise<SpeakingRoomParticipantReconciliationResult> {
    return this.exclusive(() => this.reconcileRoom(roomId, now));
  }

  async listParticipants(roomId: string, now: Date): Promise<SpeakingRoomParticipantRecord[]> {
    return this.exclusive(() => {
      this.reconcileRoom(roomId, now);
      return [...this.participants.values()]
        .filter((participant) => participant.roomId === roomId && isActiveState(participant.state))
        .sort(compareParticipants)
        .map(cloneParticipant);
    });
  }

  async countParticipants(roomId: string, now: Date): Promise<SpeakingRoomParticipantCounts> {
    return this.exclusive(() => {
      this.reconcileRoom(roomId, now);
      return countRecords([...this.participants.values()].filter(
        (participant) => participant.roomId === roomId && participant.state === 'PRESENT',
      ));
    });
  }

  async findActiveParticipant(
    roomId: string,
    userId: string,
    now: Date,
  ): Promise<SpeakingRoomParticipantRecord | null> {
    return this.exclusive(() => {
      this.reconcileRoom(roomId, now);
      const participant = [...this.participants.values()]
        .filter((candidate) => candidate.roomId === roomId && candidate.userId === userId)
        .filter((candidate) => candidate.state === 'PRESENT')
        .sort(compareParticipants)[0];
      return participant ? cloneParticipant(participant) : null;
    });
  }

  async findParticipant(
    roomId: string,
    participantId: string,
    now: Date,
  ): Promise<SpeakingRoomParticipantRecord | null> {
    return this.exclusive(() => {
      this.reconcileRoom(roomId, now);
      const participant = this.participants.get(participantId);
      return participant && participant.roomId === roomId ? cloneParticipant(participant) : null;
    });
  }

  async setParticipantRole(
    roomId: string,
    participantId: string,
    role: SpeakingRoomParticipantRole,
    now: Date,
  ): Promise<SpeakingRoomParticipantRecord> {
    return this.exclusive(() => {
      this.reconcileRoom(roomId, now);
      const participant = this.participants.get(participantId);
      if (!participant || participant.roomId !== roomId) throw new SpeakingRoomParticipantNotFoundError();
      if (!isActiveState(participant.state)) {
        throw new SpeakingRoomParticipantConflictError('INVALID_STATE', 'Participant is no longer active');
      }
      participant.role = role;
      participant.updatedAt = new Date(now);
      return cloneParticipant(participant);
    });
  }

  async removeParticipant(
    roomId: string,
    participantId: string,
    now: Date,
  ): Promise<SpeakingRoomParticipantRecord> {
    return this.exclusive(() => {
      this.reconcileRoom(roomId, now);
      const participant = this.participants.get(participantId);
      if (!participant || participant.roomId !== roomId) throw new SpeakingRoomParticipantNotFoundError();
      if (isActiveState(participant.state)) {
        participant.state = 'REMOVED';
        participant.leftAt = participant.leftAt ?? new Date(now);
        participant.updatedAt = new Date(now);
      }
      return cloneParticipant(participant);
    });
  }

  private async exclusive<T>(operation: () => T): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }

  private result(participantId: string, replayed: boolean): SpeakingRoomParticipantMutationResult {
    const participant = this.participants.get(participantId);
    if (!participant) throw new SpeakingRoomParticipantNotFoundError();
    return { participant: cloneParticipant(participant), replayed };
  }

  private findByJoinRequest(roomId: string, userId: string, requestId: string): SpeakingRoomParticipantRecord | null {
    const participantId = this.joinRequests.get(joinKey(roomId, userId, requestId));
    return participantId ? this.participants.get(participantId) ?? null : null;
  }

  private findOwned(roomId: string, userId: string, participantId: string): SpeakingRoomParticipantRecord | null {
    const participant = this.participants.get(participantId);
    return participant && participant.roomId === roomId && participant.userId === userId ? participant : null;
  }

  private findActiveByDevice(
    roomId: string,
    userId: string,
    deviceId: string,
    exceptParticipantId?: string,
  ): SpeakingRoomParticipantRecord | null {
    return [...this.participants.values()].find((participant) => (
      participant.roomId === roomId &&
      participant.userId === userId &&
      participant.deviceId === deviceId &&
      participant.id !== exceptParticipantId &&
      isActiveState(participant.state)
    )) ?? null;
  }

  private markPresent(participant: SpeakingRoomParticipantRecord, input: { deviceId: string; now: Date }): void {
    participant.deviceId = input.deviceId;
    participant.state = 'PRESENT';
    participant.lastSeenAt = new Date(input.now);
    participant.disconnectedAt = null;
    participant.updatedAt = new Date(input.now);
  }

  private recordAction(key: string, participant: SpeakingRoomParticipantRecord, action: SpeakingRoomParticipantAction): void {
    this.actions.set(key, { participantId: participant.id, action, state: participant.state });
  }

  private activeCount(roomId: string): number {
    return [...this.participants.values()]
      .filter((participant) => participant.roomId === roomId && isActiveState(participant.state))
      .length;
  }

  private reconcileRoom(roomId: string, now: Date): SpeakingRoomParticipantReconciliationResult {
    const disconnectBefore = now.getTime() - PARTICIPANT_DISCONNECT_AFTER_MS;
    const leaveBefore = now.getTime() - PARTICIPANT_RECONNECT_LEASE_MS;
    let disconnected = 0;
    let left = 0;
    for (const participant of this.participants.values()) {
      if (participant.roomId !== roomId) continue;
      if (participant.state === 'PRESENT' && participant.lastSeenAt.getTime() <= leaveBefore) {
        participant.state = 'LEFT';
        participant.disconnectedAt = participant.disconnectedAt ?? new Date(now);
        participant.leftAt = new Date(now);
        participant.updatedAt = new Date(now);
        left += 1;
      } else if (participant.state === 'PRESENT' && participant.lastSeenAt.getTime() <= disconnectBefore) {
        participant.state = 'DISCONNECTED';
        participant.disconnectedAt = new Date(now);
        participant.updatedAt = new Date(now);
        disconnected += 1;
      } else if (participant.state === 'DISCONNECTED' && participant.lastSeenAt.getTime() <= leaveBefore) {
        participant.state = 'LEFT';
        participant.leftAt = new Date(now);
        participant.updatedAt = new Date(now);
        left += 1;
      }
    }
    return { disconnected, left };
  }
}

function isActiveState(state: SpeakingRoomParticipantState): boolean {
  return state === 'PRESENT' || state === 'DISCONNECTED';
}

function actionKey(roomId: string, userId: string, requestId: string): string {
  return roomId + ':' + userId + ':' + requestId;
}

function joinKey(roomId: string, userId: string, requestId: string): string {
  return actionKey(roomId, userId, requestId);
}

function compareParticipants(left: SpeakingRoomParticipantRecord, right: SpeakingRoomParticipantRecord): number {
  const joined = left.joinedAt.getTime() - right.joinedAt.getTime();
  return joined !== 0 ? joined : left.id.localeCompare(right.id);
}

function countRecords(participants: SpeakingRoomParticipantRecord[]): SpeakingRoomParticipantCounts {
  return {
    participantCount: participants.length,
    speakerCount: participants.filter((participant) => (
      participant.role === 'SPEAKER' || participant.role === 'HOST' || participant.role === 'MODERATOR'
    )).length,
    listenerCount: participants.filter((participant) => participant.role === 'LISTENER').length,
  };
}

function cloneParticipant(participant: SpeakingRoomParticipantRecord): SpeakingRoomParticipantRecord {
  return {
    ...participant,
    joinedAt: new Date(participant.joinedAt),
    lastSeenAt: new Date(participant.lastSeenAt),
    disconnectedAt: participant.disconnectedAt ? new Date(participant.disconnectedAt) : null,
    leftAt: participant.leftAt ? new Date(participant.leftAt) : null,
    updatedAt: new Date(participant.updatedAt),
  };
}
