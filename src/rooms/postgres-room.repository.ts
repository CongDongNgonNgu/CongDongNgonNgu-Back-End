import type { Pool } from 'pg';
import {
  SpeakingRoomRepositoryConflictError,
  type CreateSpeakingRoomInput,
  type SpeakingRoomListQuery,
  type SpeakingRoomRepository,
} from './room.repository';
import type {
  SpeakingRoomLifecycle,
  SpeakingRoomRecord,
} from './room.types';

export class PostgresSpeakingRoomRepository implements SpeakingRoomRepository {
  constructor(private readonly pool: Pool) {}

  async createRoom(input: CreateSpeakingRoomInput): Promise<SpeakingRoomRecord> {
    const result = await this.pool.query(
      `WITH inserted AS (
         INSERT INTO speaking_rooms (
           host_user_id, language_id, level, topic, visibility, lifecycle,
           capacity, access_token_hash, scheduled_at, started_at, created_at, updated_at
         )
         SELECT $1, id, $2, $3, $4::speaking_room_visibility,
                $5::speaking_room_lifecycle, $6, $7, $8, $9, $10, $10
         FROM languages
         WHERE code = $11 AND active = true
         RETURNING *
       )
       SELECT inserted.*, languages.code AS language_code
       FROM inserted
       INNER JOIN languages ON languages.id = inserted.language_id`,
      [
        input.hostUserId,
        input.level,
        input.topic,
        input.visibility,
        input.lifecycle,
        input.capacity,
        input.accessTokenHash,
        input.scheduledAt,
        input.startedAt,
        input.createdAt,
        input.languageCode,
      ],
    );
    if (!result.rows[0]) {
      throw new SpeakingRoomRepositoryConflictError('Language is unavailable');
    }
    return mapRoom(result.rows[0]);
  }

  async findRoomById(id: string): Promise<SpeakingRoomRecord | null> {
    const result = await this.pool.query(
      `SELECT rooms.*, languages.code AS language_code
       FROM speaking_rooms rooms
       INNER JOIN languages ON languages.id = rooms.language_id
       WHERE rooms.id = $1`,
      [id],
    );
    return result.rows[0] ? mapRoom(result.rows[0]) : null;
  }

  async listPublicRooms(query: SpeakingRoomListQuery): Promise<SpeakingRoomRecord[]> {
    const values: unknown[] = [];
    const conditions = ["rooms.visibility = 'PUBLIC'::speaking_room_visibility"];
    if (query.languageCode) {
      values.push(query.languageCode);
      conditions.push(`languages.code = $${values.length}`);
    }
    if (query.lifecycle) {
      values.push(query.lifecycle);
      conditions.push(`rooms.lifecycle = $${values.length}::speaking_room_lifecycle`);
    }
    values.push(query.limit);
    const result = await this.pool.query(
      `SELECT rooms.*, languages.code AS language_code
       FROM speaking_rooms rooms
       INNER JOIN languages ON languages.id = rooms.language_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY rooms.created_at DESC, rooms.id DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(mapRoom);
  }

  async isModerator(roomId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM speaking_room_moderators
       WHERE room_id = $1 AND user_id = $2`,
      [roomId, userId],
    );
    return Boolean(result.rows[0]);
  }

  async addModerator(roomId: string, userId: string): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO speaking_room_moderators (room_id, user_id)
         VALUES ($1, $2) ON CONFLICT (room_id, user_id) DO NOTHING`,
        [roomId, userId],
      );
    } catch (error) {
      if (isConflict(error)) {
        throw new SpeakingRoomRepositoryConflictError('Moderator is unavailable');
      }
      throw error;
    }
  }
}

function mapRoom(row: Record<string, unknown>): SpeakingRoomRecord {
  return {
    id: String(row.id),
    hostUserId: String(row.host_user_id),
    languageCode: String(row.language_code),
    level: row.level === null || row.level === undefined ? null : String(row.level),
    topic: String(row.topic),
    visibility: row.visibility as SpeakingRoomRecord['visibility'],
    lifecycle: row.lifecycle as SpeakingRoomLifecycle,
    capacity: Number(row.capacity),
    accessTokenHash: row.access_token_hash === null || row.access_token_hash === undefined
      ? null
      : String(row.access_token_hash),
    scheduledAt: toDate(row.scheduled_at),
    startedAt: toDate(row.started_at),
    endedAt: toDate(row.ended_at),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function toDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(String(value));
}

function isConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23503';
}
