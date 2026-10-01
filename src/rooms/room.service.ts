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
import { speakingRoomFailure } from './room.errors';
import type {
  CreateSpeakingRoomDto,
  HeartbeatSpeakingRoomDto,
  IssueMediaSessionDto,
  JoinSpeakingRoomDto,
  LeaveSpeakingRoomDto,
  ListSpeakingRoomsQueryDto,
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

@Injectable()
export class SpeakingRoomService {
  constructor(
    @Inject(SPEAKING_ROOM_REPOSITORY) private readonly repository: SpeakingRoomRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository,
    @Inject(SPEAKING_ROOM_MEDIA_PROVIDER) private readonly mediaProvider: SpeakingRoomMediaProvider,
    @Inject(SPEAKING_ROOM_PARTICIPANT_REPOSITORY)
    private readonly participants: SpeakingRoomParticipantRepository,
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
    return {
      participants: await Promise.all(records.map((record) => this.toParticipantResponse(record, userId))),
      counts: await this.participants.countParticipants(room.id, new Date()),
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
  ): Promise<SpeakingRoomParticipantResponse> {
    const user = await this.identities.findUserById(participant.userId);
    const isViewer = participant.userId === viewerUserId;
    return {
      participantId: isViewer ? participant.id : null,
      displayName: user?.displayName ?? 'Community member',
      role: participant.role,
      state: participant.state,
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
