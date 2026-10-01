import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY_REPOSITORY } from '../identity/identity.module';
import type { IdentityRepository } from '../identity/identity.repository';
import type { UserRecord } from '../identity/identity.types';
import { PROFILE_REPOSITORY } from '../profile/profile.repository';
import type { ProfileRepository } from '../profile/profile.repository';
import {
  MediaProviderUnavailableError,
  SPEAKING_ROOM_MEDIA_PROVIDER,
  type MediaSessionGrant,
  type SpeakingRoomMediaProvider,
} from './media-provider';
import {
  SPEAKING_ROOM_REPOSITORY,
  SpeakingRoomRepositoryConflictError,
  type CreateSpeakingRoomInput,
  type SpeakingRoomRepository,
} from './room.repository';
import {
  PARTICIPANT_RECONNECT_LEASE_MS,
  SPEAKING_ROOM_PARTICIPANT_REPOSITORY,
  SpeakingRoomParticipantConflictError,
  SpeakingRoomParticipantNotFoundError,
  type HeartbeatSpeakingRoomParticipantInput,
  type JoinSpeakingRoomParticipantInput,
  type LeaveSpeakingRoomParticipantInput,
  type SpeakingRoomParticipantRepository,
} from './room.participant.repository';
import type {
  SpeakingRoomParticipantCounts,
  SpeakingRoomParticipantRecord,
} from './room.participant.types';
import {
  normalizeRoomCapacity,
  normalizeRoomLanguageCode,
  normalizeRoomLevel,
  normalizeRoomLifecycle,
  normalizeRoomTopic,
  normalizeRoomVisibility,
} from './room.normalization';
import {
  SPEAKING_ROOM_INTERACTION_REPOSITORY,
  SpeakingRoomInteractionConflictError,
  SpeakingRoomInteractionNotFoundError,
  type SpeakingRoomInteractionRepository,
} from './room.interaction.repository';
import type {
  SpeakingRoomChatMessageRecord,
  SpeakingRoomModerationActionRecord,
  SpeakingRoomQueueEntryRecord,
} from './room.interaction.types';
import { speakingRoomFailure } from './room.errors';
import type {
  CreateSpeakingRoomDto,
  HeartbeatSpeakingRoomDto,
  IssueMediaSessionDto,
  JoinSpeakingRoomDto,
  LeaveSpeakingRoomDto,
  ListSpeakingRoomsQueryDto,
  SpeakingRoomActionDto,
  SpeakingRoomChatMessageDto,
  SpeakingRoomChatQueryDto,
  SpeakingRoomMuteDto,
  SpeakingRoomQueueDecisionDto,
  SpeakingRoomReportDto,
} from './room.dto';
import type {
  SpeakingRoomParticipantRole,
  SpeakingRoomRecord,
} from './room.types';

const MAX_MEDIA_SESSION_SECONDS = 5 * 60;

export interface SpeakingRoomResponse {
  id: string;
  hostUserId: string;
  languageCode: string;
  level: string | null;
  topic: string;
  visibility: SpeakingRoomRecord['visibility'];
  lifecycle: SpeakingRoomRecord['lifecycle'];
  capacity: number;
  participantCount: number;
  speakerCount: number;
  listenerCount: number;
  isHost: boolean;
  isModerator: boolean;
  mediaProvider: { id: string; state: string };
  scheduledAt: Date | null;
  startedAt: Date | null;
  createdAt: Date;
}

export interface SpeakingRoomParticipantResponse {
  participantId: string | null;
  displayName: string;
  role: SpeakingRoomParticipantRecord['role'];
  state: SpeakingRoomParticipantRecord['state'];
  muted: boolean;
  joinedAt: Date;
  lastSeenAt: Date | null;
  reconnectLeaseUntil: Date | null;
}

export interface SpeakingRoomPresenceResponse {
  participants: SpeakingRoomParticipantResponse[];
  counts: SpeakingRoomParticipantCounts;
}

export interface CreateSpeakingRoomResponse {
  room: SpeakingRoomResponse;
  privateAccessToken: string | null;
}

export interface SpeakingRoomMediaSessionResponse {
  roomId: string;
  role: SpeakingRoomParticipantRole;
  providerId: string;
  providerState: string;
  providerSessionId: string;
  token: string;
  expiresAt: Date;
}

export interface SpeakingRoomQueueItemResponse {
  queueEntryId: string | null;
  participantId: string | null;
  displayName: string;
  state: SpeakingRoomQueueEntryRecord['state'];
  position: number | null;
  requestedAt: Date;
}

export interface SpeakingRoomQueueResponse {
  items: SpeakingRoomQueueItemResponse[];
  replayed?: boolean;
}

export interface SpeakingRoomModerationResponse {
  participant: SpeakingRoomParticipantResponse;
  action: SpeakingRoomModerationActionRecord['action'];
  replayed: boolean;
}

export interface SpeakingRoomBlockResponse {
  blocked: boolean;
  replayed: boolean;
}

export interface SpeakingRoomReportResponse {
  scope: 'room-report';
  submitted: true;
  replayed: boolean;
}

export interface SpeakingRoomAuditItemResponse {
  action: SpeakingRoomModerationActionRecord['action'];
  actorDisplayName: string;
  targetDisplayName: string;
  createdAt: Date;
}

export interface SpeakingRoomChatMessageResponse {
  id: string;
  displayName: string;
  body: string;
  own: boolean;
  createdAt: Date;
}

export interface SpeakingRoomChatResponse {
  items: SpeakingRoomChatMessageResponse[];
  nextCursor: string | null;
}

@Injectable()
export class SpeakingRoomService {
  constructor(
    @Inject(SPEAKING_ROOM_REPOSITORY) private readonly repository: SpeakingRoomRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository,
    @Inject(SPEAKING_ROOM_MEDIA_PROVIDER) private readonly mediaProvider: SpeakingRoomMediaProvider,
    @Inject(SPEAKING_ROOM_PARTICIPANT_REPOSITORY)
    private readonly participants: SpeakingRoomParticipantRepository,
    @Inject(SPEAKING_ROOM_INTERACTION_REPOSITORY)
    private readonly interactions: SpeakingRoomInteractionRepository,
  ) {}

  async createRoom(userId: string, input: CreateSpeakingRoomDto): Promise<CreateSpeakingRoomResponse> {
    await this.requireActiveUser(userId);
    const languageCode = normalizeOrFailure(() => normalizeRoomLanguageCode(input.languageCode), 'ROOM_LANGUAGE_INVALID');
    const language = await this.profiles.findActiveByCodes([languageCode]);
    if (language.length !== 1) {
      return speakingRoomFailure('ROOM_LANGUAGE_UNAVAILABLE', 'Language is not available', 400);
    }
    const visibility = normalizeOrFailure(() => normalizeRoomVisibility(input.visibility), 'ROOM_VISIBILITY_INVALID');
    const lifecycle = normalizeOrFailure(() => normalizeRoomLifecycle(input.lifecycle), 'ROOM_LIFECYCLE_INVALID');
    const level = normalizeOrFailure(() => normalizeRoomLevel(input.level), 'ROOM_LEVEL_INVALID');
    const topic = normalizeOrFailure(() => normalizeRoomTopic(input.topic), 'ROOM_TOPIC_INVALID');
    const capacity = normalizeOrFailure(() => normalizeRoomCapacity(input.capacity), 'ROOM_CAPACITY_INVALID');
    const now = new Date();
    const scheduledAt = input.scheduledAt ? parseScheduledAt(input.scheduledAt, now) : null;
    if (lifecycle === 'SCHEDULED' && !scheduledAt) {
      return speakingRoomFailure('ROOM_SCHEDULE_REQUIRED', 'Scheduled rooms need a future start time');
    }
    if (lifecycle === 'LIVE' && scheduledAt) {
      return speakingRoomFailure('ROOM_SCHEDULE_INVALID', 'Live rooms cannot include a future start time');
    }
    const privateAccessToken = visibility === 'PRIVATE' ? createPrivateAccessToken() : null;
    const roomInput: CreateSpeakingRoomInput = {
      hostUserId: userId,
      languageCode,
      level,
      topic,
      visibility,
      lifecycle,
      capacity,
      accessTokenHash: privateAccessToken ? hashRoomAccessToken(privateAccessToken) : null,
      scheduledAt,
      startedAt: lifecycle === 'LIVE' ? now : null,
      createdAt: now,
    };
    let room: SpeakingRoomRecord;
    try {
      room = await this.repository.createRoom(roomInput);
    } catch (error) {
      if (error instanceof SpeakingRoomRepositoryConflictError) {
        return speakingRoomFailure('ROOM_CREATE_CONFLICT', 'Room could not be created', 409);
      }
      throw error;
    }
    return { room: await this.toResponse(room, userId), privateAccessToken };
  }

  async listRooms(input: ListSpeakingRoomsQueryDto = {}, viewerUserId: string | null = null): Promise<{ items: SpeakingRoomResponse[] }> {
    const languageCode = input.languageCode
      ? normalizeOrFailure(() => normalizeRoomLanguageCode(input.languageCode!), 'ROOM_LANGUAGE_INVALID')
      : undefined;
    const rooms = await this.repository.listPublicRooms({
      languageCode,
      lifecycle: 'LIVE',
      limit: input.limit ?? 20,
    });
    return { items: await Promise.all(rooms.map((room) => this.toResponse(room, viewerUserId))) };
  }

  async getRoom(roomId: string, viewerUserId: string | null, accessToken?: string): Promise<SpeakingRoomResponse> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, viewerUserId, accessToken);
    return this.toResponse(room, viewerUserId);
  }

  async joinRoom(
    roomId: string,
    userId: string,
    input: JoinSpeakingRoomDto,
    accessToken?: string,
  ): Promise<{ participant: SpeakingRoomParticipantResponse; counts: SpeakingRoomParticipantCounts }> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    await this.requireActiveUser(userId);
    if (room.lifecycle !== 'LIVE') {
      return speakingRoomFailure('ROOM_NOT_LIVE', 'Room is not accepting participants yet', 409);
    }
    const deviceId = normalizeDeviceId(input.deviceId);
    const role = await this.deriveRole(room, userId);
    const operation: JoinSpeakingRoomParticipantInput = {
      roomId: room.id,
      userId,
      deviceId,
      joinRequestId: input.requestId,
      participantId: input.participantId ?? null,
      role,
      capacity: room.capacity,
      lifecycle: room.lifecycle,
      now: new Date(),
    };
    try {
      const result = await this.participants.joinParticipant(operation);
      return {
        participant: await this.toParticipantResponse(result.participant, userId),
        counts: await this.participants.countParticipants(room.id, new Date()),
      };
    } catch (error) {
      return mapParticipantFailure(error);
    }
  }

  async leaveRoom(
    roomId: string,
    userId: string,
    input: LeaveSpeakingRoomDto,
    accessToken?: string,
  ): Promise<{ participant: SpeakingRoomParticipantResponse; counts: SpeakingRoomParticipantCounts }> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    const operation: LeaveSpeakingRoomParticipantInput = {
      roomId: room.id,
      userId,
      participantId: input.participantId,
      requestId: input.requestId,
      mode: input.mode === 'DISCONNECT' ? 'DISCONNECT' : 'VOLUNTARY',
      now: new Date(),
    };
    try {
      const result = await this.participants.leaveParticipant(operation);
      return {
        participant: await this.toParticipantResponse(result.participant, userId),
        counts: await this.participants.countParticipants(room.id, new Date()),
      };
    } catch (error) {
      return mapParticipantFailure(error);
    }
  }

  async heartbeat(
    roomId: string,
    userId: string,
    input: HeartbeatSpeakingRoomDto,
    accessToken?: string,
  ): Promise<{ participant: SpeakingRoomParticipantResponse; counts: SpeakingRoomParticipantCounts }> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    const operation: HeartbeatSpeakingRoomParticipantInput = {
      roomId: room.id,
      userId,
      participantId: input.participantId,
      requestId: input.requestId,
      now: new Date(),
    };
    try {
      const result = await this.participants.heartbeatParticipant(operation);
      return {
        participant: await this.toParticipantResponse(result.participant, userId),
        counts: await this.participants.countParticipants(room.id, new Date()),
      };
    } catch (error) {
      return mapParticipantFailure(error);
    }
  }

  async listParticipants(
    roomId: string,
    userId: string,
    accessToken?: string,
  ): Promise<SpeakingRoomPresenceResponse> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    const records = await this.participants.listParticipants(room.id, new Date());
    const canModerate = await this.canModerate(room, userId);
    return {
      participants: await Promise.all(records.map((record) => this.toParticipantResponse(record, userId, canModerate))),
      counts: await this.participants.countParticipants(room.id, new Date()),
    };
  }

  async raiseHandWithRequest(
    roomId: string,
    userId: string,
    requestId: string,
    accessToken?: string,
  ): Promise<SpeakingRoomQueueResponse> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    const participant = await this.requireActiveParticipant(room.id, userId);
    try {
      const result = await this.interactions.raiseHand({
        roomId: room.id,
        userId,
        participantId: participant.id,
        requestId,
        now: new Date(),
      });
      return {
        items: await this.queueItems(room.id, userId, result.entry, result.participant),
        replayed: result.replayed,
      };
    } catch (error) {
      return mapInteractionFailure(error);
    }
  }

  async cancelHand(
    roomId: string,
    userId: string,
    input: SpeakingRoomActionDto,
    accessToken?: string,
  ): Promise<SpeakingRoomQueueResponse> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    const participant = await this.requireActiveParticipant(room.id, userId);
    try {
      const result = await this.interactions.cancelHand({
        roomId: room.id,
        userId,
        participantId: participant.id,
        requestId: input.requestId,
        now: new Date(),
      });
      return {
        items: await this.queueItems(room.id, userId, result.entry, result.participant),
        replayed: result.replayed,
      };
    } catch (error) {
      return mapInteractionFailure(error);
    }
  }

  async listQueue(
    roomId: string,
    userId: string,
    accessToken?: string,
  ): Promise<SpeakingRoomQueueResponse> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    await this.requireActiveParticipant(room.id, userId);
    const entries = await this.interactions.listQueue(room.id, new Date());
    const canModerate = await this.canModerate(room, userId);
    return {
      items: await this.toQueueItems(entries, userId, canModerate),
    };
  }

  async decideQueue(
    roomId: string,
    userId: string,
    queueEntryId: string,
    input: SpeakingRoomQueueDecisionDto,
    accessToken?: string,
  ): Promise<{ queueEntry: SpeakingRoomQueueItemResponse; participant: SpeakingRoomParticipantResponse; replayed: boolean }> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    await this.requireModerator(room, userId);
    await this.requireActiveParticipant(room.id, userId);
    try {
      const result = await this.interactions.decideQueue({
        roomId: room.id,
        actorUserId: userId,
        queueEntryId,
        requestId: input.requestId,
        decision: input.decision as 'ACCEPT' | 'DECLINE',
        now: new Date(),
      });
      const canModerate = true;
      return {
        queueEntry: await this.toQueueItem(result.entry, result.participant, userId, canModerate, null),
        participant: await this.toParticipantResponse(result.participant, userId, canModerate),
        replayed: result.replayed,
      };
    } catch (error) {
      return mapInteractionFailure(error);
    }
  }

  async promoteParticipant(
    roomId: string,
    userId: string,
    participantId: string,
    input: SpeakingRoomActionDto,
    accessToken?: string,
  ): Promise<SpeakingRoomModerationResponse> {
    return this.changeParticipantRole(roomId, userId, participantId, input, 'SPEAKER', accessToken);
  }

  async demoteParticipant(
    roomId: string,
    userId: string,
    participantId: string,
    input: SpeakingRoomActionDto,
    accessToken?: string,
  ): Promise<SpeakingRoomModerationResponse> {
    return this.changeParticipantRole(roomId, userId, participantId, input, 'LISTENER', accessToken);
  }

  async muteParticipant(
    roomId: string,
    userId: string,
    participantId: string,
    input: SpeakingRoomMuteDto,
    accessToken?: string,
  ): Promise<SpeakingRoomModerationResponse> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    await this.requireModerator(room, userId);
    await this.requireActiveParticipant(room.id, userId);
    const durationSeconds = input.durationSeconds ?? 300;
    try {
      const result = await this.interactions.moderateParticipant({
        roomId: room.id,
        actorUserId: userId,
        targetParticipantId: participantId,
        requestId: input.requestId,
        action: 'MUTE',
        mutedUntil: new Date(Date.now() + durationSeconds * 1000),
        reason: null,
        now: new Date(),
      });
      return {
        participant: await this.toParticipantResponse(result.participant, userId, true),
        action: result.action.action,
        replayed: result.replayed,
      };
    } catch (error) {
      return mapInteractionFailure(error);
    }
  }

  async unmuteParticipant(
    roomId: string,
    userId: string,
    participantId: string,
    input: SpeakingRoomActionDto,
    accessToken?: string,
  ): Promise<SpeakingRoomModerationResponse> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    await this.requireModerator(room, userId);
    await this.requireActiveParticipant(room.id, userId);
    try {
      const result = await this.interactions.moderateParticipant({
        roomId: room.id,
        actorUserId: userId,
        targetParticipantId: participantId,
        requestId: input.requestId,
        action: 'UNMUTE',
        mutedUntil: null,
        reason: null,
        now: new Date(),
      });
      return {
        participant: await this.toParticipantResponse(result.participant, userId, true),
        action: result.action.action,
        replayed: result.replayed,
      };
    } catch (error) {
      return mapInteractionFailure(error);
    }
  }

  async removeParticipant(
    roomId: string,
    userId: string,
    participantId: string,
    input: SpeakingRoomActionDto,
    accessToken?: string,
  ): Promise<SpeakingRoomModerationResponse> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    await this.requireModerator(room, userId);
    await this.requireActiveParticipant(room.id, userId);
    try {
      const result = await this.interactions.moderateParticipant({
        roomId: room.id,
        actorUserId: userId,
        targetParticipantId: participantId,
        requestId: input.requestId,
        action: 'REMOVE',
        mutedUntil: null,
        reason: null,
        now: new Date(),
      });
      return {
        participant: await this.toParticipantResponse(result.participant, userId, true),
        action: result.action.action,
        replayed: result.replayed,
      };
    } catch (error) {
      return mapInteractionFailure(error);
    }
  }

  async blockParticipant(
    roomId: string,
    userId: string,
    participantId: string,
    input: SpeakingRoomActionDto,
    accessToken?: string,
  ): Promise<SpeakingRoomBlockResponse> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    await this.requireActiveParticipant(room.id, userId);
    try {
      return await this.interactions.blockParticipant({
        roomId: room.id,
        actorUserId: userId,
        targetParticipantId: participantId,
        requestId: input.requestId,
        action: 'BLOCK',
        now: new Date(),
      });
    } catch (error) {
      return mapInteractionFailure(error);
    }
  }

  async unblockParticipant(
    roomId: string,
    userId: string,
    participantId: string,
    input: SpeakingRoomActionDto,
    accessToken?: string,
  ): Promise<SpeakingRoomBlockResponse> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    await this.requireActiveParticipant(room.id, userId);
    try {
      return await this.interactions.blockParticipant({
        roomId: room.id,
        actorUserId: userId,
        targetParticipantId: participantId,
        requestId: input.requestId,
        action: 'UNBLOCK',
        now: new Date(),
      });
    } catch (error) {
      return mapInteractionFailure(error);
    }
  }

  async reportParticipant(
    roomId: string,
    userId: string,
    participantId: string,
    input: SpeakingRoomReportDto,
    accessToken?: string,
  ): Promise<SpeakingRoomReportResponse> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    await this.requireActiveParticipant(room.id, userId);
    try {
      const result = await this.interactions.reportParticipant({
        roomId: room.id,
        actorUserId: userId,
        targetParticipantId: participantId,
        requestId: input.requestId,
        category: input.category as import('./room.interaction.types').SpeakingRoomReportCategory,
        details: normalizeOptionalRoomText(input.details),
        now: new Date(),
      });
      return { scope: 'room-report', submitted: true, replayed: result.replayed };
    } catch (error) {
      return mapInteractionFailure(error);
    }
  }

  async listModerationAudit(
    roomId: string,
    userId: string,
    accessToken?: string,
  ): Promise<{ items: SpeakingRoomAuditItemResponse[] }> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    await this.requireModerator(room, userId);
    const actions = await this.interactions.listModerationActions(room.id, 100);
    return { items: await Promise.all(actions.map((action) => this.toAuditItem(action))) };
  }

  async sendChat(
    roomId: string,
    userId: string,
    input: SpeakingRoomChatMessageDto,
    accessToken?: string,
  ): Promise<{ message: SpeakingRoomChatMessageResponse; replayed: boolean }> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    const participant = await this.requireActiveParticipant(room.id, userId);
    const body = normalizeRoomChatBody(input.content);
    try {
      const result = await this.interactions.sendChat({
        roomId: room.id,
        userId,
        participantId: participant.id,
        requestId: input.requestId,
        body,
        now: new Date(),
      });
      return { message: await this.toChatMessage(result.message, userId), replayed: result.replayed };
    } catch (error) {
      return mapInteractionFailure(error);
    }
  }

  async listChat(
    roomId: string,
    userId: string,
    input: SpeakingRoomChatQueryDto = {},
    accessToken?: string,
  ): Promise<SpeakingRoomChatResponse> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    await this.requireActiveParticipant(room.id, userId);
    const before = input.cursor ? decodeRoomChatCursor(input.cursor) : null;
    const page = await this.interactions.listChat({
      roomId: room.id,
      viewerUserId: userId,
      limit: input.limit ?? 50,
      before,
    });
    const items = await Promise.all(page.items.map((message) => this.toChatMessage(message, userId)));
    const last = page.items.at(-1);
    return {
      items,
      nextCursor: page.hasMore && last ? encodeRoomChatCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  private async changeParticipantRole(
    roomId: string,
    userId: string,
    participantId: string,
    input: SpeakingRoomActionDto,
    role: 'SPEAKER' | 'LISTENER',
    accessToken?: string,
  ): Promise<SpeakingRoomModerationResponse> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, accessToken);
    await this.requireModerator(room, userId);
    await this.requireActiveParticipant(room.id, userId);
    const target = await this.participants.findParticipant(room.id, participantId, new Date());
    if (!target) return speakingRoomFailure('ROOM_PARTICIPANT_NOT_FOUND', 'Participant was not found', 404);
    if (target.role === 'HOST' || target.role === 'MODERATOR') {
      return speakingRoomFailure('ROOM_MODERATION_TARGET_INVALID', 'This participant role cannot be changed', 409);
    }
    try {
      const result = await this.interactions.changeRole({
        roomId: room.id,
        actorUserId: userId,
        targetParticipantId: participantId,
        requestId: input.requestId,
        role,
        now: new Date(),
      });
      return {
        participant: await this.toParticipantResponse(result.participant, userId, true),
        action: result.action.action,
        replayed: result.replayed,
      };
    } catch (error) {
      return mapInteractionFailure(error);
    }
  }

  private async requireActiveParticipant(
    roomId: string,
    userId: string,
  ): Promise<SpeakingRoomParticipantRecord> {
    const participant = await this.participants.findActiveParticipant(roomId, userId, new Date());
    if (!participant) return speakingRoomFailure('ROOM_JOIN_REQUIRED', 'Join the room before using this capability', 409);
    return participant;
  }

  private async requireModerator(room: SpeakingRoomRecord, userId: string): Promise<void> {
    if (!await this.canModerate(room, userId)) {
      return speakingRoomFailure('ROOM_MODERATION_FORBIDDEN', 'Only the room host or moderator can do this', 403);
    }
  }

  private async canModerate(room: SpeakingRoomRecord, userId: string): Promise<boolean> {
    return room.hostUserId === userId || await this.repository.isModerator(room.id, userId);
  }

  private async queueItems(
    roomId: string,
    userId: string,
    entry: SpeakingRoomQueueEntryRecord,
    participant: SpeakingRoomParticipantRecord,
  ): Promise<SpeakingRoomQueueItemResponse[]> {
    const entries = await this.interactions.listQueue(roomId, new Date());
    const position = entries.findIndex((candidate) => candidate.id === entry.id);
    return [await this.toQueueItem(entry, participant, userId, false, position >= 0 ? position + 1 : null)];
  }

  private async toQueueItems(
    entries: SpeakingRoomQueueEntryRecord[],
    viewerUserId: string,
    viewerCanModerate: boolean,
  ): Promise<SpeakingRoomQueueItemResponse[]> {
    const items: SpeakingRoomQueueItemResponse[] = [];
    for (const [index, entry] of entries.entries()) {
      const participant = await this.participants.findParticipant(entry.roomId, entry.participantId, new Date());
      if (!participant) continue;
      items.push(await this.toQueueItem(entry, participant, viewerUserId, viewerCanModerate, index + 1));
    }
    return items;
  }

  private async toQueueItem(
    entry: SpeakingRoomQueueEntryRecord,
    participant: SpeakingRoomParticipantRecord,
    viewerUserId: string,
    viewerCanModerate: boolean,
    position: number | null,
  ): Promise<SpeakingRoomQueueItemResponse> {
    const user = await this.identities.findUserById(participant.userId);
    const isViewer = participant.userId === viewerUserId;
    return {
      queueEntryId: isViewer || viewerCanModerate ? entry.id : null,
      participantId: isViewer || viewerCanModerate ? participant.id : null,
      displayName: user?.displayName ?? 'Community member',
      state: entry.state,
      position: entry.state === 'WAITING' ? position : null,
      requestedAt: new Date(entry.createdAt),
    };
  }

  private async toAuditItem(action: SpeakingRoomModerationActionRecord): Promise<SpeakingRoomAuditItemResponse> {
    const [actor, target] = await Promise.all([
      this.identities.findUserById(action.actorUserId),
      this.identities.findUserById(action.targetUserId),
    ]);
    return {
      action: action.action,
      actorDisplayName: actor?.displayName ?? 'Community member',
      targetDisplayName: target?.displayName ?? 'Community member',
      createdAt: new Date(action.createdAt),
    };
  }

  private async toChatMessage(
    message: SpeakingRoomChatMessageRecord,
    viewerUserId: string,
  ): Promise<SpeakingRoomChatMessageResponse> {
    const author = await this.identities.findUserById(message.authorUserId);
    return {
      id: message.id,
      displayName: author?.displayName ?? 'Community member',
      body: message.body,
      own: message.authorUserId === viewerUserId,
      createdAt: new Date(message.createdAt),
    };
  }

  async issueMediaSession(
    roomId: string,
    userId: string,
    input: IssueMediaSessionDto,
  ): Promise<SpeakingRoomMediaSessionResponse> {
    const room = await this.requireRoom(roomId);
    await this.assertRoomAccess(room, userId, input.accessToken);
    if (room.lifecycle !== 'LIVE') {
      return speakingRoomFailure('ROOM_NOT_LIVE', 'Room audio is not available yet', 409);
    }
    if (this.mediaProvider.state !== 'AVAILABLE') {
      return speakingRoomFailure('ROOM_MEDIA_UNAVAILABLE', 'Live audio is temporarily unavailable', 503);
    }
    const participant = await this.participants.findActiveParticipant(room.id, userId, new Date());
    if (!participant) {
      return speakingRoomFailure('ROOM_JOIN_REQUIRED', 'Join the room before requesting audio access', 409);
    }
    if (await this.interactions.isMuted(room.id, participant.id, new Date())) {
      return speakingRoomFailure('ROOM_PARTICIPANT_MUTED', 'Audio access is muted by room moderation', 409);
    }
    const role = participant.role;
    const expiresAt = new Date(Math.min(
      Date.now() + MAX_MEDIA_SESSION_SECONDS * 1000,
      room.endedAt?.getTime() ?? Number.MAX_SAFE_INTEGER,
    ));
    try {
      const grant = await this.mediaProvider.issueSession({
        idempotencyKey: `${room.id}:${userId}:${input.requestId}`,
        roomId: room.id,
        userId,
        role,
        expiresAt,
      });
      return toMediaResponse(room.id, role, grant);
    } catch (error) {
      if (error instanceof MediaProviderUnavailableError) {
        return speakingRoomFailure('ROOM_MEDIA_UNAVAILABLE', 'Live audio is temporarily unavailable', 503);
      }
      throw error;
    }
  }

  private async requireRoom(roomId: string): Promise<SpeakingRoomRecord> {
    const room = await this.repository.findRoomById(roomId);
    if (!room) return speakingRoomFailure('ROOM_NOT_FOUND', 'Room was not found', 404);
    return room;
  }

  private async assertRoomAccess(
    room: SpeakingRoomRecord,
    viewerUserId: string | null,
    accessToken?: string,
  ): Promise<void> {
    if (room.visibility === 'PUBLIC') return;
    if (viewerUserId === room.hostUserId) return;
    if (viewerUserId && await this.repository.isModerator(room.id, viewerUserId)) return;
    if (!accessToken || !room.accessTokenHash || !safeTokenEquals(accessToken, room.accessTokenHash)) {
      return speakingRoomFailure('ROOM_NOT_FOUND', 'Room was not found', 404);
    }
  }

  private async deriveRole(room: SpeakingRoomRecord, userId: string): Promise<SpeakingRoomParticipantRole> {
    if (room.hostUserId === userId) return 'HOST';
    if (await this.repository.isModerator(room.id, userId)) return 'MODERATOR';
    return 'LISTENER';
  }

  private async toResponse(room: SpeakingRoomRecord, viewerUserId: string | null): Promise<SpeakingRoomResponse> {
    const counts = await this.participants.countParticipants(room.id, new Date());
    return {
      id: room.id,
      hostUserId: room.hostUserId,
      languageCode: room.languageCode,
      level: room.level,
      topic: room.topic,
      visibility: room.visibility,
      lifecycle: room.lifecycle,
      capacity: room.capacity,
      participantCount: counts.participantCount,
      speakerCount: counts.speakerCount,
      listenerCount: counts.listenerCount,
      isHost: viewerUserId === room.hostUserId,
      isModerator: viewerUserId ? await this.repository.isModerator(room.id, viewerUserId) : false,
      mediaProvider: {
        id: this.mediaProvider.providerId,
        state: this.mediaProvider.state,
      },
      scheduledAt: room.scheduledAt ? new Date(room.scheduledAt) : null,
      startedAt: room.startedAt ? new Date(room.startedAt) : null,
      createdAt: new Date(room.createdAt),
    };
  }

  private async toParticipantResponse(
    participant: SpeakingRoomParticipantRecord,
    viewerUserId: string,
    viewerCanModerate = false,
  ): Promise<SpeakingRoomParticipantResponse> {
    const user = await this.identities.findUserById(participant.userId);
    const isViewer = participant.userId === viewerUserId;
    return {
      participantId: isViewer || viewerCanModerate ? participant.id : null,
      displayName: user?.displayName ?? 'Community member',
      role: participant.role,
      state: participant.state,
      muted: await this.interactions.isMuted(participant.roomId, participant.id, new Date()),
      joinedAt: new Date(participant.joinedAt),
      lastSeenAt: isViewer ? new Date(participant.lastSeenAt) : null,
      reconnectLeaseUntil: isViewer && participant.state === 'DISCONNECTED'
        ? new Date(participant.lastSeenAt.getTime() + PARTICIPANT_RECONNECT_LEASE_MS)
        : null,
    };
  }

  private async requireActiveUser(userId: string): Promise<UserRecord> {
    const user = await this.identities.findUserById(userId);
    if (!user || user.status !== 'ACTIVE') {
      return speakingRoomFailure('ROOM_AUTH_REQUIRED', 'Your account cannot create a room', 403);
    }
    return user;
  }
}

function normalizeOrFailure<T>(callback: () => T, code: string): T {
  try {
    return callback();
  } catch {
    return speakingRoomFailure(code, 'Room input is invalid');
  }
}

function parseScheduledAt(value: string, now: Date): Date {
  const scheduledAt = new Date(value);
  if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= now.getTime()) {
    return speakingRoomFailure('ROOM_SCHEDULE_INVALID', 'Room start time must be in the future');
  }
  return scheduledAt;
}

function createPrivateAccessToken(): string {
  return 'room_' + randomBytes(32).toString('base64url');
}

function hashRoomAccessToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeTokenEquals(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashRoomAccessToken(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function toMediaResponse(
  roomId: string,
  role: SpeakingRoomParticipantRole,
  grant: MediaSessionGrant,
): SpeakingRoomMediaSessionResponse {
  return {
    roomId,
    role,
    providerId: grant.providerId,
    providerState: grant.providerState,
    providerSessionId: grant.providerSessionId,
    token: grant.token,
    expiresAt: new Date(grant.expiresAt),
  };
}

function normalizeDeviceId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    return speakingRoomFailure('ROOM_DEVICE_INVALID', 'Participant device identity is invalid');
  }
  return normalized;
}

function mapParticipantFailure(error: unknown): never {
  if (error instanceof SpeakingRoomParticipantNotFoundError) {
    return speakingRoomFailure('ROOM_PARTICIPANT_NOT_FOUND', 'Participant was not found', 404);
  }
  if (error instanceof SpeakingRoomParticipantConflictError) {
    if (error.reason === 'CAPACITY') {
      return speakingRoomFailure('ROOM_CAPACITY_REACHED', 'Room capacity has been reached', 409);
    }
    if (error.reason === 'ROOM_NOT_JOINABLE') {
      return speakingRoomFailure('ROOM_NOT_LIVE', 'Room is not accepting participants yet', 409);
    }
    if (error.reason === 'DEVICE_CONFLICT') {
      return speakingRoomFailure('ROOM_DEVICE_CONFLICT', 'This device already has an active room presence', 409);
    }
    if (error.reason === 'REQUEST_REUSED') {
      return speakingRoomFailure('ROOM_REQUEST_REUSED', 'Request id was already used', 409);
    }
    return speakingRoomFailure('ROOM_PARTICIPANT_STATE_INVALID', 'Participant state cannot be changed', 409);
  }
  throw error;
}

function mapInteractionFailure(error: unknown): never {
  if (error instanceof SpeakingRoomInteractionNotFoundError) {
    return speakingRoomFailure('ROOM_PARTICIPANT_NOT_FOUND', 'Participant was not found', 404);
  }
  if (error instanceof SpeakingRoomInteractionConflictError) {
    if (error.reason === 'RATE_LIMITED') {
      return speakingRoomFailure('ROOM_CHAT_RATE_LIMITED', 'Room chat rate limit exceeded', 429);
    }
    if (error.reason === 'REQUEST_REUSED') {
      return speakingRoomFailure('ROOM_REQUEST_REUSED', 'Request id was already used', 409);
    }
    if (error.reason === 'QUEUE_NOT_WAITING') {
      return speakingRoomFailure('ROOM_QUEUE_STATE_INVALID', 'The hand raise is no longer pending', 409);
    }
    return speakingRoomFailure('ROOM_INTERACTION_STATE_INVALID', 'Room interaction cannot be changed', 409);
  }
  throw error;
}

function normalizeRoomChatBody(value: string): string {
  const normalized = value.trim().replace(/\r\n?/gu, '\n');
  if (!normalized || normalized.length > 1_000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)) {
    return speakingRoomFailure('ROOM_CHAT_INVALID', 'Chat message is invalid');
  }
  return normalized;
}

function normalizeOptionalRoomText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 1_000 || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    return speakingRoomFailure('ROOM_REPORT_INVALID', 'Report details are invalid');
  }
  return normalized;
}

function encodeRoomChatCursor(cursor: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }), 'utf8')
    .toString('base64url');
}

function decodeRoomChatCursor(value: string): { createdAt: Date; id: string } {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown };
    if (typeof decoded.createdAt !== 'string' || typeof decoded.id !== 'string' || decoded.id.length > 64) {
      throw new Error('invalid cursor');
    }
    const createdAt = new Date(decoded.createdAt);
    if (Number.isNaN(createdAt.getTime())) throw new Error('invalid cursor');
    return { createdAt, id: decoded.id };
  } catch {
    return speakingRoomFailure('ROOM_CHAT_CURSOR_INVALID', 'Chat cursor is invalid');
  }
}
