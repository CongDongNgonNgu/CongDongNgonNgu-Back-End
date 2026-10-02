import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  EventRepositoryConflictError,
  EventRepositoryHostError,
  EventRepositoryNotFoundError,
  type CancelEventResult,
  type CreateEventRepositoryInput,
  type EventListQuery,
  type EventRepository,
} from './event.repository';
import type {
  EventRecurrenceDefinition,
  EventRecord,
  EventStatus,
  EventVenueType,
  EventVisibility,
} from './event.types';

const EVENT_SELECT = `
  SELECT e.*, l.code AS language_code,
         s.frequency AS series_frequency,
         s.recurrence_interval AS series_interval,
         s.occurrence_count AS series_count,
         s.occurrence_until_at AS series_until_at,
         s.by_weekdays AS series_by_weekdays
    FROM community_events e
    INNER JOIN languages l ON l.id = e.language_id
    LEFT JOIN event_recurrence_series s ON s.id = e.recurrence_series_id
`;

export class PostgresEventRepository implements EventRepository {
  constructor(private readonly pool: Pool) {}

  async createEvent(input: CreateEventRepositoryInput): Promise<EventRecord> {
    const client = await this.pool.connect();
    const recurrenceSeriesId = input.recurrence ? randomUUID() : null;
    try {
      await client.query('BEGIN');
      if (input.recurrence) {
        await client.query(
          `INSERT INTO event_recurrence_series (
             id, host_user_id, timezone, frequency, recurrence_interval,
             occurrence_count, occurrence_until_at, by_weekdays, created_at, updated_at
           ) VALUES ($1, $2, $3, $4::event_recurrence_frequency, $5, $6, $7, $8, $9, $9)`,
          [
            recurrenceSeriesId,
            input.hostUserId,
            input.timezone,
            input.recurrence.frequency,
            input.recurrence.interval,
            input.recurrence.count,
            input.recurrence.until,
            input.recurrence.byWeekday,
            input.createdAt,
          ],
        );
      }

      const result = await client.query(
        `WITH inserted AS (
           INSERT INTO community_events (
             host_user_id, title, language_id, level, topic, starts_at, ends_at,
             timezone, capacity, visibility, venue_type, speaking_room_id,
             recurrence_series_id, status, cancelled_at, cancelled_by_user_id,
             created_at, updated_at
           )
           SELECT $1, $2, l.id, $4, $5, $6, $7, $8, $9,
                  $10::event_visibility, $11::event_venue_type, $12, $13,
                  'SCHEDULED'::event_status, NULL, NULL, $14, $15
             FROM languages l
            WHERE l.code = $3 AND l.active = true
           RETURNING *
         )
         ${EVENT_SELECT.replace('FROM community_events e', 'FROM inserted e')}`,
        [
          input.hostUserId,
          input.title,
          input.languageCode,
          input.level,
          input.topic,
          input.startAt,
          input.endAt,
          input.timezone,
          input.capacity,
          input.visibility,
          input.venueType,
          input.speakingRoomId,
          recurrenceSeriesId,
          input.createdAt,
          input.updatedAt,
        ],
      );
      if (!result.rows[0]) {
        throw new EventRepositoryConflictError('Event language is unavailable');
      }
      await client.query('COMMIT');
      return mapEventRow(result.rows[0]);
    } catch (error) {
      await rollbackQuietly(client);
      if (isForeignKeyViolation(error))
        throw new EventRepositoryConflictError('Event relation is unavailable');
      if (isUniqueViolation(error))
        throw new EventRepositoryConflictError(
          'Event conflicts with existing data',
        );
      throw error;
    } finally {
      client.release();
    }
  }

  async findEventById(id: string): Promise<EventRecord | null> {
    const result = await this.pool.query(`${EVENT_SELECT} WHERE e.id = $1`, [
      id,
    ]);
    return result.rows[0] ? mapEventRow(result.rows[0]) : null;
  }

  async listPublicEvents(query: EventListQuery): Promise<EventRecord[]> {
    const values: unknown[] = [];
    const conditions = ["e.visibility = 'PUBLIC'::event_visibility"];
    if (query.languageCode) {
      values.push(query.languageCode);
      conditions.push(`l.code = $${values.length}`);
    }
    if (query.state && query.state !== 'ALL') {
      if (!query.now)
        throw new Error('Event list state requires a reference time');
      values.push(query.now);
      const nowPlaceholder = `$${values.length}`;
      if (query.state === 'CANCELLED') {
        conditions.push("e.status = 'CANCELLED'::event_status");
      } else if (query.state === 'UPCOMING') {
        conditions.push(
          `e.status = 'SCHEDULED'::event_status AND e.starts_at > ${nowPlaceholder}`,
        );
      } else if (query.state === 'LIVE') {
        conditions.push(
          `e.status = 'SCHEDULED'::event_status AND e.starts_at <= ${nowPlaceholder} AND e.ends_at > ${nowPlaceholder}`,
        );
      } else {
        conditions.push(
          `e.status = 'SCHEDULED'::event_status AND e.ends_at <= ${nowPlaceholder}`,
        );
      }
    }
    values.push(query.limit);
    const result = await this.pool.query(
      `${EVENT_SELECT}
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.starts_at ASC, e.id ASC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(mapEventRow);
  }

  async cancelEvent(
    eventId: string,
    hostUserId: string,
    now: Date,
  ): Promise<CancelEventResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT id, host_user_id, status FROM community_events WHERE id = $1 FOR UPDATE`,
        [eventId],
      );
      const row = current.rows[0];
      if (!row) throw new EventRepositoryNotFoundError('Event does not exist');
      if (String(row.host_user_id) !== hostUserId)
        throw new EventRepositoryHostError();
      const replayed = row.status === 'CANCELLED';
      if (!replayed) {
        await client.query(
          `UPDATE community_events
              SET status = 'CANCELLED'::event_status,
                  cancelled_at = $2,
                  cancelled_by_user_id = $3,
                  updated_at = $2
            WHERE id = $1`,
          [eventId, now, hostUserId],
        );
      }
      const result = await client.query(`${EVENT_SELECT} WHERE e.id = $1`, [
        eventId,
      ]);
      if (!result.rows[0])
        throw new EventRepositoryNotFoundError('Event does not exist');
      await client.query('COMMIT');
      return { record: mapEventRow(result.rows[0]), replayed };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapEventRow(row: QueryResultRow): EventRecord {
  const recurrenceSeriesId =
    row.recurrence_series_id === null || row.recurrence_series_id === undefined
      ? null
      : String(row.recurrence_series_id);
  const recurrence: EventRecurrenceDefinition | null = recurrenceSeriesId
    ? {
        frequency:
          row.series_frequency as EventRecurrenceDefinition['frequency'],
        interval: Number(row.series_interval),
        count:
          row.series_count === null || row.series_count === undefined
            ? null
            : Number(row.series_count),
        until: toDate(row.series_until_at),
        byWeekday: Array.isArray(row.series_by_weekdays)
          ? (row.series_by_weekdays.map((value: unknown) =>
              String(value),
            ) as EventRecurrenceDefinition['byWeekday'])
          : [],
      }
    : null;
  return {
    id: String(row.id),
    hostUserId: String(row.host_user_id),
    title: String(row.title),
    languageCode: String(row.language_code),
    level:
      row.level === null || row.level === undefined ? null : String(row.level),
    topic:
      row.topic === null || row.topic === undefined ? null : String(row.topic),
    startAt: toRequiredDate(row.starts_at),
    endAt: toRequiredDate(row.ends_at),
    timezone: String(row.timezone),
    capacity: Number(row.capacity),
    visibility: row.visibility as EventVisibility,
    venueType: row.venue_type as EventVenueType,
    speakingRoomId:
      row.speaking_room_id === null || row.speaking_room_id === undefined
        ? null
        : String(row.speaking_room_id),
    recurrenceSeriesId,
    recurrence,
    status: row.status as EventStatus,
    cancelledAt: toDate(row.cancelled_at),
    cancelledByUserId:
      row.cancelled_by_user_id === null ||
      row.cancelled_by_user_id === undefined
        ? null
        : String(row.cancelled_by_user_id),
    createdAt: toRequiredDate(row.created_at),
    updatedAt: toRequiredDate(row.updated_at),
  };
}

function toDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(String(value));
}

function toRequiredDate(value: unknown): Date {
  const date = toDate(value);
  if (!date) throw new Error('Event timestamp is missing');
  return date;
}

function isForeignKeyViolation(error: unknown): boolean {
  return isPostgresError(error) && error.code === '23503';
}

function isUniqueViolation(error: unknown): boolean {
  return isPostgresError(error) && error.code === '23505';
}

function isPostgresError(error: unknown): error is { code?: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original repository failure.
  }
}
