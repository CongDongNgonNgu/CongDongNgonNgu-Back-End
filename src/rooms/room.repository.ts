import { randomUUID } from 'node:crypto';
import type {
  SpeakingRoomLifecycle,
  SpeakingRoomRecord,
  SpeakingRoomVisibility,
} from './room.types';

export const SPEAKING_ROOM_REPOSITORY = 'SPEAKING_ROOM_REPOSITORY';

export class SpeakingRoomRepositoryConflictError extends Error {
  constructor(message = 'Speaking room conflicts with existing data') {
    super(message);
    this.name = 'SpeakingRoomRepositoryConflictError';
  }
}

export interface CreateSpeakingRoomInput {
  hostUserId: string;
  languageCode: string;
  level: string | null;
  topic: string;
  visibility: SpeakingRoomVisibility;
  lifecycle: SpeakingRoomLifecycle;
  capacity: number;
  accessTokenHash: string | null;
  scheduledAt: Date | null;
  startedAt: Date | null;
  createdAt: Date;
}

export interface SpeakingRoomListQuery {
  languageCode?: string;
  lifecycle?: SpeakingRoomLifecycle;
  limit: number;
}

export interface SpeakingRoomRepository {
  createRoom(input: CreateSpeakingRoomInput): Promise<SpeakingRoomRecord>;
  findRoomById(id: string): Promise<SpeakingRoomRecord | null>;
  listPublicRooms(query: SpeakingRoomListQuery): Promise<SpeakingRoomRecord[]>;
  isModerator(roomId: string, userId: string): Promise<boolean>;
  addModerator(roomId: string, userId: string): Promise<void>;
}

export class InMemorySpeakingRoomRepository implements SpeakingRoomRepository {
  private readonly rooms = new Map<string, SpeakingRoomRecord>();
  private readonly moderators = new Set<string>();

  async createRoom(input: CreateSpeakingRoomInput): Promise<SpeakingRoomRecord> {
    const now = new Date(input.createdAt);
    const room: SpeakingRoomRecord = {
      id: randomUUID(),
      hostUserId: input.hostUserId,
      languageCode: input.languageCode,
      level: input.level,
      topic: input.topic,
      visibility: input.visibility,
      lifecycle: input.lifecycle,
      capacity: input.capacity,
      accessTokenHash: input.accessTokenHash,
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      startedAt: input.startedAt ? new Date(input.startedAt) : null,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rooms.set(room.id, room);
    return cloneRoom(room);
  }

  async findRoomById(id: string): Promise<SpeakingRoomRecord | null> {
    const room = this.rooms.get(id);
    return room ? cloneRoom(room) : null;
  }

  async listPublicRooms(query: SpeakingRoomListQuery): Promise<SpeakingRoomRecord[]> {
    return [...this.rooms.values()]
      .filter((room) => room.visibility === 'PUBLIC')
      .filter((room) => !query.languageCode || room.languageCode === query.languageCode)
      .filter((room) => !query.lifecycle || room.lifecycle === query.lifecycle)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, query.limit)
      .map(cloneRoom);
  }

  async isModerator(roomId: string, userId: string): Promise<boolean> {
    return this.moderators.has(moderatorKey(roomId, userId));
  }

  async addModerator(roomId: string, userId: string): Promise<void> {
    this.moderators.add(moderatorKey(roomId, userId));
  }
}

function moderatorKey(roomId: string, userId: string): string {
  return roomId + ':' + userId;
}

function cloneRoom(room: SpeakingRoomRecord): SpeakingRoomRecord {
  return {
    ...room,
    scheduledAt: room.scheduledAt ? new Date(room.scheduledAt) : null,
    startedAt: room.startedAt ? new Date(room.startedAt) : null,
    endedAt: room.endedAt ? new Date(room.endedAt) : null,
    createdAt: new Date(room.createdAt),
    updatedAt: new Date(room.updatedAt),
  };
}
