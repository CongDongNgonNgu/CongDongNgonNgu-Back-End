import { randomUUID } from 'node:crypto';
import type { SpeakingRoomParticipantRepository } from './room.participant.repository';
import type { SpeakingRoomParticipantRecord } from './room.participant.types';
import type { SpeakingRoomParticipantRole } from './room.types';
import type {
  SpeakingRoomChatCursor,
  SpeakingRoomChatMessageRecord,
  SpeakingRoomModerationActionRecord,
  SpeakingRoomModerationActionType,
  SpeakingRoomQueueActionType,
  SpeakingRoomQueueEntryRecord,
  SpeakingRoomQueueState,
  SpeakingRoomReportCategory,
} from './room.interaction.types';

export const SPEAKING_ROOM_INTERACTION_REPOSITORY = 'SPEAKING_ROOM_INTERACTION_REPOSITORY';
export const ROOM_CHAT_RATE_LIMIT = 5;
export const ROOM_CHAT_RATE_WINDOW_MS = 10_000;

export interface RaiseHandInput {
  roomId: string;
  userId: string;
  participantId: string;
  requestId: string;
  now: Date;
}

export interface CancelHandInput extends RaiseHandInput {}

export interface QueueDecisionInput {
  roomId: string;
  actorUserId: string;
  queueEntryId: string;
  requestId: string;
  decision: 'ACCEPT' | 'DECLINE';
  now: Date;
}

export interface ChangeRoleInput {
  roomId: string;
  actorUserId: string;
  targetParticipantId: string;
  requestId: string;
  role: Extract<SpeakingRoomParticipantRole, 'SPEAKER' | 'LISTENER'>;
  now: Date;
}

export interface ModerateParticipantInput {
  roomId: string;
  actorUserId: string;
  targetParticipantId: string;
  requestId: string;
  action: Extract<SpeakingRoomModerationActionType, 'MUTE' | 'UNMUTE' | 'REMOVE'>;
  mutedUntil: Date | null;
  reason: string | null;
  now: Date;
}

export interface BlockParticipantInput {
  roomId: string;
  actorUserId: string;
  targetParticipantId: string;
  requestId: string;
  action: 'BLOCK' | 'UNBLOCK';
  now: Date;
}

export interface ReportParticipantInput {
  roomId: string;
  actorUserId: string;
  targetParticipantId: string;
  requestId: string;
  category: SpeakingRoomReportCategory;
  details: string | null;
  now: Date;
}

export interface SendChatInput {
  roomId: string;
  userId: string;
  participantId: string;
  requestId: string;
  body: string;
  now: Date;
}

export interface ListChatInput {
  roomId: string;
  viewerUserId: string;
  limit: number;
  before: SpeakingRoomChatCursor | null;
}

export interface SpeakingRoomQueueMutation {
  entry: SpeakingRoomQueueEntryRecord;
  participant: SpeakingRoomParticipantRecord;
  replayed: boolean;
}

export interface SpeakingRoomModerationMutation {
  participant: SpeakingRoomParticipantRecord;
  action: SpeakingRoomModerationActionRecord;
  replayed: boolean;
}

export interface SpeakingRoomBlockMutation {
  blocked: boolean;
  replayed: boolean;
}

export interface SpeakingRoomReportMutation {
  duplicate: boolean;
  replayed: boolean;
}

export interface SpeakingRoomChatMutation {
  message: SpeakingRoomChatMessageRecord;
  replayed: boolean;
}

export interface SpeakingRoomChatPage {
  items: SpeakingRoomChatMessageRecord[];
  hasMore: boolean;
}

export class SpeakingRoomInteractionNotFoundError extends Error {
  constructor(message = 'Speaking room interaction target was not found') {
    super(message);
    this.name = 'SpeakingRoomInteractionNotFoundError';
  }
}

export type SpeakingRoomInteractionConflictReason =
  | 'REQUEST_REUSED'
  | 'INVALID_STATE'
  | 'QUEUE_NOT_WAITING'
  | 'RATE_LIMITED';

export class SpeakingRoomInteractionConflictError extends Error {
  constructor(
    readonly reason: SpeakingRoomInteractionConflictReason,
    message = 'Speaking room interaction conflicts with existing state',
  ) {
    super(message);
    this.name = 'SpeakingRoomInteractionConflictError';
  }
}

export interface SpeakingRoomInteractionRepository {
  raiseHand(input: RaiseHandInput): Promise<SpeakingRoomQueueMutation>;
  cancelHand(input: CancelHandInput): Promise<SpeakingRoomQueueMutation>;
  listQueue(roomId: string, now: Date): Promise<SpeakingRoomQueueEntryRecord[]>;
  decideQueue(input: QueueDecisionInput): Promise<SpeakingRoomQueueMutation>;
  changeRole(input: ChangeRoleInput): Promise<SpeakingRoomModerationMutation>;
  moderateParticipant(input: ModerateParticipantInput): Promise<SpeakingRoomModerationMutation>;
  isMuted(roomId: string, participantId: string, now: Date): Promise<boolean>;
  blockParticipant(input: BlockParticipantInput): Promise<SpeakingRoomBlockMutation>;
  isBlocked(roomId: string, firstUserId: string, secondUserId: string): Promise<boolean>;
  reportParticipant(input: ReportParticipantInput): Promise<SpeakingRoomReportMutation>;
  listModerationActions(roomId: string, limit: number): Promise<SpeakingRoomModerationActionRecord[]>;
  sendChat(input: SendChatInput): Promise<SpeakingRoomChatMutation>;
  listChat(input: ListChatInput): Promise<SpeakingRoomChatPage>;
}

interface RecordedQueueAction {
  action: SpeakingRoomQueueActionType;
  entryId: string;
}

interface RecordedReport {
  duplicate: boolean;
}

/** Deterministic test adapter; production wiring uses the Postgres repository. */
export class InMemorySpeakingRoomInteractionRepository implements SpeakingRoomInteractionRepository {
  private readonly queueEntries = new Map<string, SpeakingRoomQueueEntryRecord>();
  private readonly queueActions = new Map<string, RecordedQueueAction>();
  private readonly moderationActions = new Map<string, SpeakingRoomModerationActionRecord>();
  private readonly moderationActionsById = new Map<string, SpeakingRoomModerationActionRecord>();
  private readonly mutedUntil = new Map<string, Date>();
  private readonly blocks = new Set<string>();
  private readonly reports = new Set<string>();
  private readonly reportRequests = new Map<string, RecordedReport>();
  private readonly chatMessages = new Map<string, SpeakingRoomChatMessageRecord>();
  private readonly chatActions = new Map<string, string>();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly participants: SpeakingRoomParticipantRepository) {}

  async raiseHand(input: RaiseHandInput): Promise<SpeakingRoomQueueMutation> {
    return this.exclusive(async () => {
      const actionKeyValue = actionKey(input.roomId, input.userId, input.requestId);
      const recorded = this.queueActions.get(actionKeyValue);
      if (recorded) {
        if (recorded.action !== 'RAISE_HAND') throw requestReused();
        return this.queueResult(recorded.entryId, true);
      }
      const participant = await this.requireParticipant(input.roomId, input.participantId, input.now);
      assertParticipantOwner(participant, input.userId);
      assertActiveParticipant(participant);
      if (participant.role !== 'LISTENER') {
        throw new SpeakingRoomInteractionConflictError('INVALID_STATE', 'Only listeners can raise a hand');
      }
      const existing = this.findWaitingEntry(input.roomId, input.participantId);
      if (existing) {
        this.queueActions.set(actionKeyValue, { action: 'RAISE_HAND', entryId: existing.id });
        return this.queueResult(existing.id, true);
      }
      const entry: SpeakingRoomQueueEntryRecord = {
        id: randomUUID(),
        roomId: input.roomId,
        participantId: input.participantId,
        userId: input.userId,
        state: 'WAITING',
        createdAt: new Date(input.now),
        updatedAt: new Date(input.now),
        decidedAt: null,
        decidedByUserId: null,
      };
      this.queueEntries.set(entry.id, entry);
      this.queueActions.set(actionKeyValue, { action: 'RAISE_HAND', entryId: entry.id });
      return this.queueResult(entry.id, false);
    });
  }

  async cancelHand(input: CancelHandInput): Promise<SpeakingRoomQueueMutation> {
    return this.exclusive(async () => {
      const actionKeyValue = actionKey(input.roomId, input.userId, input.requestId);
      const recorded = this.queueActions.get(actionKeyValue);
      if (recorded) {
        if (recorded.action !== 'CANCEL_HAND') throw requestReused();
        return this.queueResult(recorded.entryId, true);
      }
      const participant = await this.requireParticipant(input.roomId, input.participantId, input.now);
      assertParticipantOwner(participant, input.userId);
      assertActiveParticipant(participant);
      const entry = this.findWaitingEntry(input.roomId, input.participantId);
      if (!entry) throw new SpeakingRoomInteractionConflictError('QUEUE_NOT_WAITING', 'There is no pending hand raise');
      entry.state = 'CANCELLED';
      entry.updatedAt = new Date(input.now);
      this.queueActions.set(actionKeyValue, { action: 'CANCEL_HAND', entryId: entry.id });
      return this.queueResult(entry.id, false);
    });
  }

  async listQueue(roomId: string, now: Date): Promise<SpeakingRoomQueueEntryRecord[]> {
    return this.exclusive(async () => {
      await this.participants.reconcileStaleParticipants(roomId, now);
      const entries: SpeakingRoomQueueEntryRecord[] = [];
      for (const entry of this.queueEntries.values()) {
        if (entry.roomId !== roomId || entry.state !== 'WAITING') continue;
        const participant = await this.participants.findParticipant(roomId, entry.participantId, now);
        if (!participant || !isActiveParticipantState(participant.state)) {
          entry.state = 'CANCELLED';
          entry.updatedAt = new Date(now);
          continue;
        }
        entries.push(cloneQueueEntry(entry));
      }
      return entries.sort(compareQueueEntries);
    });
  }

  async decideQueue(input: QueueDecisionInput): Promise<SpeakingRoomQueueMutation> {
    return this.exclusive(async () => {
      const actionKeyValue = actionKey(input.roomId, input.actorUserId, input.requestId);
      const recorded = this.queueActions.get(actionKeyValue);
      if (recorded) {
        if (recorded.action !== input.decision) throw requestReused();
        return this.queueResult(recorded.entryId, true);
      }
      const entry = this.queueEntries.get(input.queueEntryId);
      if (!entry || entry.roomId !== input.roomId) throw new SpeakingRoomInteractionNotFoundError();
      if (entry.state !== 'WAITING') {
        throw new SpeakingRoomInteractionConflictError('QUEUE_NOT_WAITING', 'The hand raise is no longer pending');
      }
      const participant = await this.requireParticipant(input.roomId, entry.participantId, input.now);
      assertActiveParticipant(participant);
      entry.state = input.decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';
      entry.decidedAt = new Date(input.now);
      entry.decidedByUserId = input.actorUserId;
      entry.updatedAt = new Date(input.now);
      const updated = input.decision === 'ACCEPT'
        ? await this.participants.setParticipantRole(input.roomId, participant.id, 'SPEAKER', input.now)
        : participant;
      const audit = this.recordModerationAction({
        roomId: input.roomId,
        actorUserId: input.actorUserId,
        targetParticipantId: participant.id,
        targetUserId: participant.userId,
        action: input.decision === 'ACCEPT' ? 'ACCEPT_QUEUE' : 'DECLINE_QUEUE',
        reason: null,
        createdAt: input.now,
      }, actionKeyValue);
      void audit;
      this.queueActions.set(actionKeyValue, {
        action: input.decision,
        entryId: entry.id,
      });
      return { entry: cloneQueueEntry(entry), participant: cloneParticipant(updated), replayed: false };
    });
  }

  async changeRole(input: ChangeRoleInput): Promise<SpeakingRoomModerationMutation> {
    return this.exclusive(async () => {
      const actionKeyValue = actionKey(input.roomId, input.actorUserId, input.requestId);
      const recorded = this.moderationActions.get(actionKeyValue);
      if (recorded) {
        if (recorded.action !== (input.role === 'SPEAKER' ? 'PROMOTE' : 'DEMOTE')) throw requestReused();
        const participant = await this.requireParticipant(input.roomId, input.targetParticipantId, input.now);
        return { participant, action: cloneAction(recorded), replayed: true };
      }
      const participant = await this.requireParticipant(input.roomId, input.targetParticipantId, input.now);
      assertActiveParticipant(participant);
      const action = input.role === 'SPEAKER' ? 'PROMOTE' : 'DEMOTE';
      const updated = await this.participants.setParticipantRole(input.roomId, participant.id, input.role, input.now);
      this.acceptWaitingQueueForParticipant(input.roomId, participant.id, input.actorUserId, input.now, input.role);
      const audit = this.recordModerationAction({
        roomId: input.roomId,
        actorUserId: input.actorUserId,
        targetParticipantId: participant.id,
        targetUserId: participant.userId,
        action,
        reason: null,
        createdAt: input.now,
      }, actionKeyValue);
      return { participant: cloneParticipant(updated), action: cloneAction(audit), replayed: false };
    });
  }

  async moderateParticipant(input: ModerateParticipantInput): Promise<SpeakingRoomModerationMutation> {
    return this.exclusive(async () => {
      const actionKeyValue = actionKey(input.roomId, input.actorUserId, input.requestId);
      const recorded = this.moderationActions.get(actionKeyValue);
      if (recorded) {
        if (recorded.action !== input.action) throw requestReused();
        const participant = await this.requireParticipant(input.roomId, input.targetParticipantId, input.now);
        return { participant, action: cloneAction(recorded), replayed: true };
      }
      const participant = await this.requireParticipant(input.roomId, input.targetParticipantId, input.now);
      if (input.action === 'REMOVE') {
        await this.participants.removeParticipant(input.roomId, participant.id, input.now);
        this.cancelWaitingEntries(input.roomId, participant.id, input.now);
      } else if (!isActiveParticipantState(participant.state)) {
        throw new SpeakingRoomInteractionConflictError('INVALID_STATE', 'Participant is no longer active');
      } else if (input.action === 'MUTE') {
        this.mutedUntil.set(participant.id, new Date(input.mutedUntil!.getTime()));
      } else {
        this.mutedUntil.delete(participant.id);
      }
      const updated = await this.requireParticipant(input.roomId, participant.id, input.now);
      const audit = this.recordModerationAction({
        roomId: input.roomId,
        actorUserId: input.actorUserId,
        targetParticipantId: participant.id,
        targetUserId: participant.userId,
        action: input.action,
        reason: input.reason,
        createdAt: input.now,
      }, actionKeyValue);
      return { participant: cloneParticipant(updated), action: cloneAction(audit), replayed: false };
    });
  }

  async isMuted(_roomId: string, participantId: string, now: Date): Promise<boolean> {
    const mutedUntil = this.mutedUntil.get(participantId);
    return Boolean(mutedUntil && mutedUntil.getTime() > now.getTime());
  }

  async blockParticipant(input: BlockParticipantInput): Promise<SpeakingRoomBlockMutation> {
    return this.exclusive(async () => {
      const actionKeyValue = actionKey(input.roomId, input.actorUserId, input.requestId);
      const recorded = this.moderationActions.get(actionKeyValue);
      if (recorded) {
        if (recorded.action !== input.action) throw requestReused();
        return { blocked: input.action === 'BLOCK', replayed: true };
      }
      const target = await this.requireParticipant(input.roomId, input.targetParticipantId, input.now);
      if (target.userId === input.actorUserId) {
        throw new SpeakingRoomInteractionConflictError('INVALID_STATE', 'A participant cannot block themselves');
      }
      const key = blockKey(input.roomId, input.actorUserId, target.userId);
      if (input.action === 'BLOCK') this.blocks.add(key);
      else this.blocks.delete(key);
      this.recordModerationAction({
        roomId: input.roomId,
        actorUserId: input.actorUserId,
        targetParticipantId: target.id,
        targetUserId: target.userId,
        action: input.action,
        reason: null,
        createdAt: input.now,
      }, actionKeyValue);
      return { blocked: input.action === 'BLOCK', replayed: false };
    });
  }

  async isBlocked(roomId: string, firstUserId: string, secondUserId: string): Promise<boolean> {
    return this.blocks.has(blockKey(roomId, firstUserId, secondUserId))
      || this.blocks.has(blockKey(roomId, secondUserId, firstUserId));
  }

  async reportParticipant(input: ReportParticipantInput): Promise<SpeakingRoomReportMutation> {
    return this.exclusive(async () => {
      const actionKeyValue = actionKey(input.roomId, input.actorUserId, input.requestId);
      const recorded = this.reportRequests.get(actionKeyValue);
      if (recorded) return { duplicate: recorded.duplicate, replayed: true };
      const target = await this.requireParticipant(input.roomId, input.targetParticipantId, input.now);
      if (target.userId === input.actorUserId) {
        throw new SpeakingRoomInteractionConflictError('INVALID_STATE', 'A participant cannot report themselves');
      }
      const reportKey = [input.roomId, input.actorUserId, target.id, input.category].join(':');
      const duplicate = this.reports.has(reportKey);
      this.reports.add(reportKey);
      this.reportRequests.set(actionKeyValue, { duplicate });
      this.recordModerationAction({
        roomId: input.roomId,
        actorUserId: input.actorUserId,
        targetParticipantId: target.id,
        targetUserId: target.userId,
        action: 'REPORT',
        reason: input.details,
        resultDuplicate: duplicate,
        createdAt: input.now,
      }, actionKeyValue);
      return { duplicate, replayed: false };
    });
  }

  async listModerationActions(roomId: string, limit: number): Promise<SpeakingRoomModerationActionRecord[]> {
    return [...this.moderationActionsById.values()]
      .filter((action) => action.roomId === roomId)
      .sort(compareActions)
      .slice(0, limit)
      .map(cloneAction);
  }

  async sendChat(input: SendChatInput): Promise<SpeakingRoomChatMutation> {
    return this.exclusive(async () => {
      const actionKeyValue = actionKey(input.roomId, input.userId, input.requestId);
      const recordedMessageId = this.chatActions.get(actionKeyValue);
      if (recordedMessageId) {
        const message = this.chatMessages.get(recordedMessageId);
        if (!message) throw new SpeakingRoomInteractionNotFoundError();
        return { message: cloneMessage(message), replayed: true };
      }
      const participant = await this.requireParticipant(input.roomId, input.participantId, input.now);
      assertParticipantOwner(participant, input.userId);
      assertActiveParticipant(participant);
      const cutoff = input.now.getTime() - ROOM_CHAT_RATE_WINDOW_MS;
      const recentCount = [...this.chatMessages.values()].filter((message) => (
        message.roomId === input.roomId &&
        message.authorUserId === input.userId &&
        message.createdAt.getTime() > cutoff
      )).length;
      if (recentCount >= ROOM_CHAT_RATE_LIMIT) {
        throw new SpeakingRoomInteractionConflictError('RATE_LIMITED', 'Room chat rate limit exceeded');
      }
      const message: SpeakingRoomChatMessageRecord = {
        id: randomUUID(),
        roomId: input.roomId,
        authorParticipantId: participant.id,
        authorUserId: input.userId,
        body: input.body,
        createdAt: new Date(input.now),
      };
      this.chatMessages.set(message.id, message);
      this.chatActions.set(actionKeyValue, message.id);
      return { message: cloneMessage(message), replayed: false };
    });
  }

  async listChat(input: ListChatInput): Promise<SpeakingRoomChatPage> {
    const items = [...this.chatMessages.values()]
      .filter((message) => message.roomId === input.roomId)
      .filter((message) => !input.before || isBeforeCursor(message, input.before))
      .filter((message) => !this.blocks.has(blockKey(input.roomId, input.viewerUserId, message.authorUserId)))
      .filter((message) => !this.blocks.has(blockKey(input.roomId, message.authorUserId, input.viewerUserId)))
      .sort(compareMessages)
      .slice(0, input.limit + 1);
    return {
      items: items.slice(0, input.limit).map(cloneMessage),
      hasMore: items.length > input.limit,
    };
  }

  private async requireParticipant(
    roomId: string,
    participantId: string,
    now: Date,
  ): Promise<SpeakingRoomParticipantRecord> {
    const participant = await this.participants.findParticipant(roomId, participantId, now);
    if (!participant) throw new SpeakingRoomInteractionNotFoundError();
    return participant;
  }

  private async queueResult(entryId: string, replayed: boolean): Promise<SpeakingRoomQueueMutation> {
    const entry = this.queueEntries.get(entryId);
    if (!entry) throw new SpeakingRoomInteractionNotFoundError();
    const participant = await this.participants.findParticipant(entry.roomId, entry.participantId, entry.updatedAt);
    if (!participant) throw new SpeakingRoomInteractionNotFoundError();
    return {
      entry: cloneQueueEntry(entry),
      participant,
      replayed,
    };
  }

  private findWaitingEntry(roomId: string, participantId: string): SpeakingRoomQueueEntryRecord | null {
    return [...this.queueEntries.values()]
      .filter((entry) => entry.roomId === roomId && entry.participantId === participantId && entry.state === 'WAITING')
      .sort(compareQueueEntries)[0] ?? null;
  }

  private acceptWaitingQueueForParticipant(
    roomId: string,
    participantId: string,
    actorUserId: string,
    now: Date,
    role: SpeakingRoomParticipantRole,
  ): void {
    if (role !== 'SPEAKER') return;
    const entry = this.findWaitingEntry(roomId, participantId);
    if (!entry) return;
    entry.state = 'ACCEPTED';
    entry.decidedAt = new Date(now);
    entry.decidedByUserId = actorUserId;
    entry.updatedAt = new Date(now);
  }

  private cancelWaitingEntries(roomId: string, participantId: string, now: Date): void {
    for (const entry of this.queueEntries.values()) {
      if (entry.roomId === roomId && entry.participantId === participantId && entry.state === 'WAITING') {
        entry.state = 'CANCELLED';
        entry.updatedAt = new Date(now);
      }
    }
  }

  private recordModerationAction(
    action: Omit<SpeakingRoomModerationActionRecord, 'id'>,
    requestKey: string,
  ): SpeakingRoomModerationActionRecord {
    const existing = this.moderationActions.get(requestKey);
    if (existing) return existing;
    const record: SpeakingRoomModerationActionRecord = { id: randomUUID(), ...action };
    this.moderationActions.set(requestKey, record);
    this.moderationActionsById.set(record.id, record);
    return record;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function requestReused(): SpeakingRoomInteractionConflictError {
  return new SpeakingRoomInteractionConflictError('REQUEST_REUSED', 'Request id was already used');
}

function actionKey(roomId: string, userId: string, requestId: string): string {
  return roomId + ':' + userId + ':' + requestId;
}

function blockKey(roomId: string, firstUserId: string, secondUserId: string): string {
  return roomId + ':' + firstUserId + ':' + secondUserId;
}

function isActiveParticipantState(state: SpeakingRoomParticipantRecord['state']): boolean {
  return state === 'PRESENT' || state === 'DISCONNECTED';
}

function assertActiveParticipant(participant: SpeakingRoomParticipantRecord): void {
  if (!isActiveParticipantState(participant.state)) {
    throw new SpeakingRoomInteractionConflictError('INVALID_STATE', 'Participant is no longer active');
  }
}

function assertParticipantOwner(participant: SpeakingRoomParticipantRecord, userId: string): void {
  if (participant.userId !== userId) {
    throw new SpeakingRoomInteractionNotFoundError();
  }
}

function compareQueueEntries(left: SpeakingRoomQueueEntryRecord, right: SpeakingRoomQueueEntryRecord): number {
  const time = left.createdAt.getTime() - right.createdAt.getTime();
  return time !== 0 ? time : left.id.localeCompare(right.id);
}

function compareActions(left: SpeakingRoomModerationActionRecord, right: SpeakingRoomModerationActionRecord): number {
  const time = right.createdAt.getTime() - left.createdAt.getTime();
  return time !== 0 ? time : right.id.localeCompare(left.id);
}

function compareMessages(left: SpeakingRoomChatMessageRecord, right: SpeakingRoomChatMessageRecord): number {
  const time = right.createdAt.getTime() - left.createdAt.getTime();
  return time !== 0 ? time : right.id.localeCompare(left.id);
}

function isBeforeCursor(message: SpeakingRoomChatMessageRecord, cursor: SpeakingRoomChatCursor): boolean {
  const time = message.createdAt.getTime() - cursor.createdAt.getTime();
  return time < 0 || (time === 0 && message.id < cursor.id);
}

function cloneQueueEntry(entry: SpeakingRoomQueueEntryRecord): SpeakingRoomQueueEntryRecord {
  return {
    ...entry,
    createdAt: new Date(entry.createdAt),
    updatedAt: new Date(entry.updatedAt),
    decidedAt: entry.decidedAt ? new Date(entry.decidedAt) : null,
  };
}

function cloneAction(action: SpeakingRoomModerationActionRecord): SpeakingRoomModerationActionRecord {
  return { ...action, createdAt: new Date(action.createdAt) };
}

function cloneMessage(message: SpeakingRoomChatMessageRecord): SpeakingRoomChatMessageRecord {
  return { ...message, createdAt: new Date(message.createdAt) };
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
