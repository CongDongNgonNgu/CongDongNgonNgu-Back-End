import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  EventAttendanceReplayConflictError,
  EventParticipationRepositoryConflictError,
  EventParticipationRepositoryNotFoundError,
  type EventParticipationRepository,
  type RecordEventAttendanceInput,
  type RegisterEventContext,
} from './event.participation.repository';
import {
  type EventAttendanceRecord,
  type EventAttendanceResult,
  type EventInvitationRecord,
  type EventReminderIntent,
  type EventReminderIntentInput,
  type EventRegistrationRecord,
  type EventRegistrationResult,
} from './event.participation.types';
import type { EventRecord } from './event.types';

export class PostgresEventParticipationRepository
  implements EventParticipationRepository
{
  constructor(private readonly pool: Pool) {}

  async hasActiveInvitation(eventId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
         FROM event_invitations
        WHERE event_id = $1
          AND invited_user_id = $2
          AND status = 'ACTIVE'::event_invitation_status
        LIMIT 1`,
      [eventId, userId],
    );
    return result.rowCount === 1;
  }

  async inviteUser(
    eventId: string,
    invitedUserId: string,
    invitedByUserId: string,
    now: Date,
  ): Promise<{ record: EventInvitationRecord; replayed: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT * FROM event_invitations
          WHERE event_id = $1 AND invited_user_id = $2
          FOR UPDATE`,
        [eventId, invitedUserId],
      );
      const existing = current.rows[0];
      if (existing?.status === 'ACTIVE') {
        await client.query('COMMIT');
        return { record: mapInvitationRow(existing), replayed: true };
      }
      const result = existing
        ? await client.query(
            `UPDATE event_invitations
                SET invited_by_user_id = $3,
                    status = 'ACTIVE'::event_invitation_status,
                    invited_at = $4,
                    revoked_at = NULL,
                    updated_at = $4
              WHERE id = $1
              RETURNING *`,
            [existing.id, eventId, invitedByUserId, now],
          )
        : await client.query(
            `INSERT INTO event_invitations
              (event_id, invited_user_id, invited_by_user_id, status, invited_at, updated_at)
             VALUES ($1, $2, $3, 'ACTIVE'::event_invitation_status, $4, $4)
             RETURNING *`,
            [eventId, invitedUserId, invitedByUserId, now],
          );
      if (!result.rows[0]) {
        throw new EventParticipationRepositoryNotFoundError('Event invitation was not created');
      }
      await client.query('COMMIT');
      return { record: mapInvitationRow(result.rows[0]), replayed: false };
    } catch (error) {
      await rollbackQuietly(client);
      if (isForeignKeyViolation(error)) {
        throw new EventParticipationRepositoryNotFoundError('Event invitation relation is unavailable');
      }
      if (isUniqueViolation(error)) {
        throw new EventParticipationRepositoryConflictError('Event invitation already exists');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeInvitation(
    eventId: string,
    invitedUserId: string,
    _revokedByUserId: string,
    now: Date,
  ): Promise<{ record: EventInvitationRecord | null; replayed: boolean }> {
    const result = await this.pool.query(
      `UPDATE event_invitations
          SET status = 'REVOKED'::event_invitation_status,
              revoked_at = $3,
              updated_at = $3
        WHERE event_id = $1
          AND invited_user_id = $2
          AND status = 'ACTIVE'::event_invitation_status
        RETURNING *`,
      [eventId, invitedUserId, now],
    );
    if (result.rows[0]) {
      return { record: mapInvitationRow(result.rows[0]), replayed: false };
    }
    const existing = await this.pool.query(
      `SELECT * FROM event_invitations
        WHERE event_id = $1 AND invited_user_id = $2`,
      [eventId, invitedUserId],
    );
    return {
      record: existing.rows[0] ? mapInvitationRow(existing.rows[0]) : null,
      replayed: true,
    };
  }

  async registerEvent(
    event: RegisterEventContext,
    userId: string,
    now: Date,
  ): Promise<EventRegistrationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const eventResult = await client.query(
        `SELECT id, capacity, status, starts_at, ends_at
           FROM community_events
          WHERE id = $1
          FOR UPDATE`,
        [event.id],
      );
      const eventRow = eventResult.rows[0];
      if (!eventRow) throw new EventParticipationRepositoryNotFoundError('Event does not exist');

      const existingResult = await client.query(
        `SELECT * FROM event_registrations
          WHERE event_id = $1 AND user_id = $2
          FOR UPDATE`,
        [event.id, userId],
      );
      const existing = existingResult.rows[0];
      if (existing && existing.status !== 'CANCELLED') {
        await client.query('COMMIT');
        return { record: mapRegistrationRow(existing), replayed: true, promoted: [] };
      }

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS count
           FROM event_registrations
          WHERE event_id = $1
            AND status = 'REGISTERED'::event_registration_status`,
        [event.id],
      );
      const isRegistered = Number(countResult.rows[0]?.count ?? 0) < Number(eventRow.capacity);
      const status = isRegistered ? 'REGISTERED' : 'WAITLISTED';
      const waitlistPosition = isRegistered
        ? null
        : await this.nextWaitlistPosition(client, event.id);
      const result = existing
        ? await client.query(
            `UPDATE event_registrations
                SET status = $2::event_registration_status,
                    waitlist_position = $3,
                    registered_at = $4,
                    cancelled_at = NULL,
                    updated_at = $4
              WHERE id = $1
              RETURNING *`,
            [existing.id, status, waitlistPosition, now],
          )
        : await client.query(
            `INSERT INTO event_registrations
              (event_id, user_id, status, waitlist_position, registered_at, created_at, updated_at)
             VALUES ($1, $2, $3::event_registration_status, $4, $5, $5, $5)
             RETURNING *`,
            [event.id, userId, status, waitlistPosition, now],
          );
      if (!result.rows[0]) {
        throw new EventParticipationRepositoryNotFoundError('Event registration was not created');
      }
      const promoted = await this.promoteWaitlisted(
        client,
        event.id,
        Number(eventRow.capacity),
        now,
      );
      await client.query('COMMIT');
      return {
        record: mapRegistrationRow(result.rows[0]),
        replayed: false,
        promoted,
      };
    } catch (error) {
      await rollbackQuietly(client);
      if (isForeignKeyViolation(error)) {
        throw new EventParticipationRepositoryNotFoundError('Event does not exist');
      }
      if (isUniqueViolation(error)) {
        throw new EventParticipationRepositoryConflictError('Event registration already exists');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelRegistration(
    event: Pick<EventRecord, 'id' | 'capacity'>,
    userId: string,
    now: Date,
  ): Promise<EventRegistrationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const eventResult = await client.query(
        `SELECT id, capacity FROM community_events WHERE id = $1 FOR UPDATE`,
        [event.id],
      );
      const eventRow = eventResult.rows[0];
      if (!eventRow) throw new EventParticipationRepositoryNotFoundError('Event does not exist');
      const current = await client.query(
        `SELECT * FROM event_registrations
          WHERE event_id = $1 AND user_id = $2
          FOR UPDATE`,
        [event.id, userId],
      );
      const existing = current.rows[0];
      if (!existing) {
        throw new EventParticipationRepositoryNotFoundError('Event registration does not exist');
      }
      if (existing.status === 'CANCELLED') {
        await client.query('COMMIT');
        return { record: mapRegistrationRow(existing), replayed: true, promoted: [] };
      }
      const result = await client.query(
        `UPDATE event_registrations
            SET status = 'CANCELLED'::event_registration_status,
                waitlist_position = NULL,
                cancelled_at = $3,
                updated_at = $3
          WHERE id = $1
          RETURNING *`,
        [existing.id, event.id, now],
      );
      const promoted = await this.promoteWaitlisted(
        client,
        event.id,
        Number(eventRow.capacity),
        now,
      );
      await client.query('COMMIT');
      return {
        record: mapRegistrationRow(result.rows[0]),
        replayed: false,
        promoted,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async findRegistration(
    eventId: string,
    userId: string,
  ): Promise<EventRegistrationRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM event_registrations WHERE event_id = $1 AND user_id = $2`,
      [eventId, userId],
    );
    return result.rows[0] ? mapRegistrationRow(result.rows[0]) : null;
  }

  async cancelEventParticipation(eventId: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE event_registrations
          SET status = 'CANCELLED'::event_registration_status,
              waitlist_position = NULL,
              cancelled_at = $2,
              updated_at = $2
        WHERE event_id = $1
          AND status <> 'CANCELLED'::event_registration_status`,
      [eventId, now],
    );
    await this.pool.query(
      `UPDATE event_reminder_intents
          SET status = 'CANCELLED'::event_reminder_status,
              suppression_reason = 'EVENT_CANCELLED',
              updated_at = $2
        WHERE event_id = $1`,
      [eventId, now],
    );
  }

  async upsertReminderIntents(
    inputs: readonly EventReminderIntentInput[],
  ): Promise<EventReminderIntent[]> {
    if (inputs.length === 0) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const records: EventReminderIntent[] = [];
      for (const input of inputs) {
        const result = await client.query(
          `INSERT INTO event_reminder_intents
            (event_id, user_id, registration_id, kind, scheduled_for,
             recipient_timezone, status, suppression_reason, created_at, updated_at)
           VALUES ($1, $2, $3, $4::event_reminder_kind, $5, $6,
                   $7::event_reminder_status, $8, $9, $9)
           ON CONFLICT (event_id, user_id, kind)
           DO UPDATE SET
             registration_id = EXCLUDED.registration_id,
             scheduled_for = EXCLUDED.scheduled_for,
             recipient_timezone = EXCLUDED.recipient_timezone,
             status = EXCLUDED.status,
             suppression_reason = EXCLUDED.suppression_reason,
             updated_at = EXCLUDED.updated_at
           RETURNING *`,
          [
            input.eventId,
            input.userId,
            input.registrationId,
            input.kind,
            input.scheduledFor,
            input.recipientTimezone,
            input.status,
            input.suppressionReason,
            input.now,
          ],
        );
        if (!result.rows[0]) throw new EventParticipationRepositoryConflictError('Reminder intent was not stored');
        records.push(mapReminderRow(result.rows[0]));
      }
      await client.query('COMMIT');
      return records;
    } catch (error) {
      await rollbackQuietly(client);
      if (isForeignKeyViolation(error)) {
        throw new EventParticipationRepositoryNotFoundError('Reminder relation is unavailable');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelReminderIntents(eventId: string, userId?: string, now = new Date()): Promise<void> {
    const values: unknown[] = [eventId];
    let userFilter = '';
    if (userId) {
      values.push(userId);
      userFilter = ` AND user_id = $${values.length}`;
    }
    values.push(now);
    await this.pool.query(
      `UPDATE event_reminder_intents
          SET status = 'CANCELLED'::event_reminder_status,
              suppression_reason = 'REGISTRATION_CANCELLED',
              updated_at = $${values.length}
        WHERE event_id = $1${userFilter}`,
      values,
    );
  }

  async listReminderIntents(
    eventId: string,
    userId?: string,
  ): Promise<EventReminderIntent[]> {
    const values: unknown[] = [eventId];
    let userFilter = '';
    if (userId) {
      values.push(userId);
      userFilter = ` AND user_id = $${values.length}`;
    }
    const result = await this.pool.query(
      `SELECT * FROM event_reminder_intents
        WHERE event_id = $1${userFilter}
        ORDER BY scheduled_for ASC, kind ASC, id ASC`,
      values,
    );
    return result.rows.map(mapReminderRow);
  }

  async recordAttendance(
    input: RecordEventAttendanceInput,
  ): Promise<EventAttendanceResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const registration = await client.query(
        `SELECT id FROM event_registrations
          WHERE event_id = $1 AND user_id = $2
            AND status = 'REGISTERED'::event_registration_status
          FOR SHARE`,
        [input.eventId, input.userId],
      );
      if (!registration.rows[0]) {
        throw new EventParticipationRepositoryNotFoundError('Registered participant does not exist');
      }
      const existingResult = await client.query(
        `SELECT * FROM event_attendance
          WHERE event_id = $1 AND user_id = $2
          FOR UPDATE`,
        [input.eventId, input.userId],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (String(existing.fingerprint) !== input.fingerprint) {
          throw new EventAttendanceReplayConflictError();
        }
        await client.query('COMMIT');
        return { record: mapAttendanceRow(existing), replayed: true };
      }
      const result = await client.query(
        `INSERT INTO event_attendance
          (event_id, user_id, evidence_type, evidence_id, marked_by_user_id,
           occurred_at, fingerprint, created_at, updated_at)
         VALUES ($1, $2, $3::event_attendance_evidence_type, $4, $5, $6, $7, $8, $8)
         RETURNING *`,
        [
          input.eventId,
          input.userId,
          input.evidenceType,
          input.evidenceId,
          input.markedByUserId,
          input.occurredAt,
          input.fingerprint,
          input.now,
        ],
      );
      if (!result.rows[0]) throw new EventParticipationRepositoryConflictError('Attendance was not recorded');
      await client.query('COMMIT');
      return { record: mapAttendanceRow(result.rows[0]), replayed: false };
    } catch (error) {
      await rollbackQuietly(client);
      if (isForeignKeyViolation(error)) {
        throw new EventParticipationRepositoryNotFoundError('Attendance relation is unavailable');
      }
      if (isUniqueViolation(error)) {
        throw new EventParticipationRepositoryConflictError('Attendance already exists');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async findAttendance(
    eventId: string,
    userId: string,
  ): Promise<EventAttendanceRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM event_attendance WHERE event_id = $1 AND user_id = $2`,
      [eventId, userId],
    );
    return result.rows[0] ? mapAttendanceRow(result.rows[0]) : null;
  }

  private async nextWaitlistPosition(client: PoolClient, eventId: string): Promise<number> {
    const result = await client.query(
      `SELECT COALESCE(MAX(waitlist_position), 0)::int + 1 AS next_position
         FROM event_registrations
        WHERE event_id = $1
          AND status = 'WAITLISTED'::event_registration_status`,
      [eventId],
    );
    return Number(result.rows[0]?.next_position ?? 1);
  }

  private async promoteWaitlisted(
    client: PoolClient,
    eventId: string,
    capacity: number,
    now: Date,
  ): Promise<EventRegistrationRecord[]> {
    const countResult = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM event_registrations
        WHERE event_id = $1
          AND status = 'REGISTERED'::event_registration_status`,
      [eventId],
    );
    const slots = Math.max(0, capacity - Number(countResult.rows[0]?.count ?? 0));
    const promoted: EventRegistrationRecord[] = [];
    if (slots > 0) {
      const candidates = await client.query(
        `SELECT * FROM event_registrations
          WHERE event_id = $1
            AND status = 'WAITLISTED'::event_registration_status
          ORDER BY registered_at ASC, id ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [eventId, slots],
      );
      for (const candidate of candidates.rows) {
        const updated = await client.query(
          `UPDATE event_registrations
              SET status = 'REGISTERED'::event_registration_status,
                  waitlist_position = NULL,
                  updated_at = $2
            WHERE id = $1
            RETURNING *`,
          [candidate.id, now],
        );
        if (updated.rows[0]) promoted.push(mapRegistrationRow(updated.rows[0]));
      }
    }
    await client.query(
      `WITH ranked AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY registered_at ASC, id ASC)::int AS position
           FROM event_registrations
          WHERE event_id = $1
            AND status = 'WAITLISTED'::event_registration_status
       )
       UPDATE event_registrations r
          SET waitlist_position = ranked.position,
              updated_at = $2
         FROM ranked
        WHERE r.id = ranked.id`,
      [eventId, now],
    );
    return promoted;
  }
}

function mapRegistrationRow(row: QueryResultRow): EventRegistrationRecord {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    userId: String(row.user_id),
    status: row.status,
    waitlistPosition:
      row.waitlist_position === null || row.waitlist_position === undefined
        ? null
        : Number(row.waitlist_position),
    registeredAt: toDate(row.registered_at),
    cancelledAt: row.cancelled_at ? toDate(row.cancelled_at) : null,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapInvitationRow(row: QueryResultRow): EventInvitationRecord {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    invitedUserId: String(row.invited_user_id),
    invitedByUserId: String(row.invited_by_user_id),
    status: row.status,
    invitedAt: toDate(row.invited_at),
    revokedAt: row.revoked_at ? toDate(row.revoked_at) : null,
    updatedAt: toDate(row.updated_at),
  };
}

function mapReminderRow(row: QueryResultRow): EventReminderIntent {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    userId: String(row.user_id),
    registrationId: String(row.registration_id),
    kind: row.kind,
    scheduledFor: toDate(row.scheduled_for),
    recipientTimezone: String(row.recipient_timezone),
    status: row.status,
    suppressionReason: row.suppression_reason ? String(row.suppression_reason) : null,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapAttendanceRow(row: QueryResultRow): EventAttendanceRecord {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    userId: String(row.user_id),
    evidenceType: row.evidence_type,
    evidenceId: String(row.evidence_id),
    markedByUserId: row.marked_by_user_id ? String(row.marked_by_user_id) : null,
    occurredAt: toDate(row.occurred_at),
    fingerprint: String(row.fingerprint),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toDate(value: unknown): Date {
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('Event participation timestamp is invalid');
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
