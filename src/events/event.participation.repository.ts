import { randomUUID } from 'node:crypto';
import type { EventRecord } from './event.types';
import {
  cloneEventAttendance,
  cloneEventRegistration,
  cloneEventReminderIntent,
  type EventAttendanceRecord,
  type EventAttendanceResult,
  type EventInvitationRecord,
  type EventReminderIntent,
  type EventReminderIntentInput,
  type EventRegistrationRecord,
  type EventRegistrationResult,
} from './event.participation.types';

export const EVENT_PARTICIPATION_REPOSITORY = 'EVENT_PARTICIPATION_REPOSITORY';

export class EventParticipationRepositoryNotFoundError extends Error {
  constructor(message = 'Event participation data was not found') {
    super(message);
    this.name = 'EventParticipationRepositoryNotFoundError';
  }
}

export class EventParticipationRepositoryConflictError extends Error {
  constructor(message = 'Event participation data conflicts with existing data') {
    super(message);
    this.name = 'EventParticipationRepositoryConflictError';
  }
}

export class EventAttendanceReplayConflictError extends Error {
  constructor(message = 'Attendance evidence conflicts with existing evidence') {
    super(message);
    this.name = 'EventAttendanceReplayConflictError';
  }
}

export interface RegisterEventContext
  extends Pick<
    EventRecord,
    'id' | 'hostUserId' | 'capacity' | 'visibility' | 'startAt' | 'endAt' | 'status'
  > {}

export interface RecordEventAttendanceInput {
  eventId: string;
  userId: string;
  evidenceType: EventAttendanceRecord['evidenceType'];
  evidenceId: string;
  markedByUserId: string | null;
  occurredAt: Date;
  fingerprint: string;
  now: Date;
}

export interface EventParticipationRepository {
  hasActiveInvitation(eventId: string, userId: string): Promise<boolean>;
  inviteUser(
    eventId: string,
    invitedUserId: string,
    invitedByUserId: string,
    now: Date,
  ): Promise<{ record: EventInvitationRecord; replayed: boolean }>;
  revokeInvitation(
    eventId: string,
    invitedUserId: string,
    revokedByUserId: string,
    now: Date,
  ): Promise<{ record: EventInvitationRecord | null; replayed: boolean }>;
  registerEvent(
    event: RegisterEventContext,
    userId: string,
    now: Date,
  ): Promise<EventRegistrationResult>;
  cancelRegistration(
    event: Pick<EventRecord, 'id' | 'capacity'>,
    userId: string,
    now: Date,
  ): Promise<EventRegistrationResult>;
  findRegistration(
    eventId: string,
    userId: string,
  ): Promise<EventRegistrationRecord | null>;
  cancelEventParticipation(eventId: string, now: Date): Promise<void>;
  upsertReminderIntents(
    inputs: readonly EventReminderIntentInput[],
  ): Promise<EventReminderIntent[]>;
  cancelReminderIntents(eventId: string, userId?: string, now?: Date): Promise<void>;
  listReminderIntents(
    eventId: string,
    userId?: string,
  ): Promise<EventReminderIntent[]>;
  recordAttendance(
    input: RecordEventAttendanceInput,
  ): Promise<EventAttendanceResult>;
  findAttendance(
    eventId: string,
    userId: string,
  ): Promise<EventAttendanceRecord | null>;
}

/** Deterministic adapter used by service tests; production uses Postgres. */
export class InMemoryEventParticipationRepository
  implements EventParticipationRepository
{
  private readonly invitations = new Map<string, EventInvitationRecord>();
  private readonly registrations = new Map<string, EventRegistrationRecord>();
  private readonly reminders = new Map<string, EventReminderIntent>();
  private readonly attendance = new Map<string, EventAttendanceRecord>();
  private writeTail: Promise<void> = Promise.resolve();

  async hasActiveInvitation(eventId: string, userId: string): Promise<boolean> {
    const record = this.invitations.get(invitationKey(eventId, userId));
    return record?.status === 'ACTIVE';
  }

  async inviteUser(
    eventId: string,
    invitedUserId: string,
    invitedByUserId: string,
    now: Date,
  ): Promise<{ record: EventInvitationRecord; replayed: boolean }> {
    return this.exclusive(() => {
      const key = invitationKey(eventId, invitedUserId);
      const existing = this.invitations.get(key);
      if (existing?.status === 'ACTIVE') {
        return { record: cloneInvitation(existing), replayed: true };
      }
      const record: EventInvitationRecord = existing
        ? {
            ...existing,
            invitedByUserId,
            status: 'ACTIVE',
            invitedAt: new Date(now),
            revokedAt: null,
            updatedAt: new Date(now),
          }
        : {
            id: randomUUID(),
            eventId,
            invitedUserId,
            invitedByUserId,
            status: 'ACTIVE',
            invitedAt: new Date(now),
            revokedAt: null,
            updatedAt: new Date(now),
          };
      this.invitations.set(key, record);
      return { record: cloneInvitation(record), replayed: false };
    });
  }

  async revokeInvitation(
    eventId: string,
    invitedUserId: string,
    _revokedByUserId: string,
    now: Date,
  ): Promise<{ record: EventInvitationRecord | null; replayed: boolean }> {
    return this.exclusive(() => {
      const key = invitationKey(eventId, invitedUserId);
      const existing = this.invitations.get(key);
      if (!existing || existing.status === 'REVOKED') {
        return { record: existing ? cloneInvitation(existing) : null, replayed: true };
      }
      existing.status = 'REVOKED';
      existing.revokedAt = new Date(now);
      existing.updatedAt = new Date(now);
      return { record: cloneInvitation(existing), replayed: false };
    });
  }

  async registerEvent(
    event: RegisterEventContext,
    userId: string,
    now: Date,
  ): Promise<EventRegistrationResult> {
    return this.exclusive(() => {
      const key = registrationKey(event.id, userId);
      const existing = this.registrations.get(key);
      if (existing && existing.status !== 'CANCELLED') {
        return {
          record: cloneEventRegistration(existing),
          replayed: true,
          promoted: [],
        };
      }

      const registeredCount = this.countRegistered(event.id);
      const status = registeredCount < event.capacity ? 'REGISTERED' : 'WAITLISTED';
      const record: EventRegistrationRecord = existing
        ? {
            ...existing,
            status,
            waitlistPosition: status === 'WAITLISTED' ? this.nextWaitlistPosition(event.id) : null,
            registeredAt: new Date(now),
            cancelledAt: null,
            updatedAt: new Date(now),
          }
        : {
            id: randomUUID(),
            eventId: event.id,
            userId,
            status,
            waitlistPosition: status === 'WAITLISTED' ? this.nextWaitlistPosition(event.id) : null,
            registeredAt: new Date(now),
            cancelledAt: null,
            createdAt: new Date(now),
            updatedAt: new Date(now),
          };
      this.registrations.set(key, record);
      const promoted = this.rebalance(event.id, event.capacity, now);
      return {
        record: cloneEventRegistration(record),
        replayed: false,
        promoted: promoted.map(cloneEventRegistration),
      };
    });
  }

  async cancelRegistration(
    event: Pick<EventRecord, 'id' | 'capacity'>,
    userId: string,
    now: Date,
  ): Promise<EventRegistrationResult> {
    return this.exclusive(() => {
      const key = registrationKey(event.id, userId);
      const record = this.registrations.get(key);
      if (!record) {
        throw new EventParticipationRepositoryNotFoundError(
          'Event registration does not exist',
        );
      }
      if (record.status === 'CANCELLED') {
        return {
          record: cloneEventRegistration(record),
          replayed: true,
          promoted: [],
        };
      }
      record.status = 'CANCELLED';
      record.waitlistPosition = null;
      record.cancelledAt = new Date(now);
      record.updatedAt = new Date(now);
      const promoted = this.rebalance(event.id, event.capacity, now);
      return {
        record: cloneEventRegistration(record),
        replayed: false,
        promoted: promoted.map(cloneEventRegistration),
      };
    });
  }

  async findRegistration(
    eventId: string,
    userId: string,
  ): Promise<EventRegistrationRecord | null> {
    const record = this.registrations.get(registrationKey(eventId, userId));
    return record ? cloneEventRegistration(record) : null;
  }

  async cancelEventParticipation(eventId: string, now: Date): Promise<void> {
    await this.exclusive(() => {
      for (const record of this.registrations.values()) {
        if (record.eventId !== eventId || record.status === 'CANCELLED') continue;
        record.status = 'CANCELLED';
        record.waitlistPosition = null;
        record.cancelledAt = new Date(now);
        record.updatedAt = new Date(now);
      }
      for (const reminder of this.reminders.values()) {
        if (reminder.eventId === eventId) {
          reminder.status = 'CANCELLED';
          reminder.suppressionReason = 'EVENT_CANCELLED';
          reminder.updatedAt = new Date(now);
        }
      }
    });
  }

  async upsertReminderIntents(
    inputs: readonly EventReminderIntentInput[],
  ): Promise<EventReminderIntent[]> {
    return this.exclusive(() => inputs.map((input) => {
      const key = reminderKey(input.eventId, input.userId, input.kind);
      const existing = this.reminders.get(key);
      const record: EventReminderIntent = existing
        ? {
            ...existing,
            registrationId: input.registrationId,
            scheduledFor: new Date(input.scheduledFor),
            recipientTimezone: input.recipientTimezone,
            status: input.status,
            suppressionReason: input.suppressionReason,
            updatedAt: new Date(input.now),
          }
        : {
            id: randomUUID(),
            eventId: input.eventId,
            userId: input.userId,
            registrationId: input.registrationId,
            kind: input.kind,
            scheduledFor: new Date(input.scheduledFor),
            recipientTimezone: input.recipientTimezone,
            status: input.status,
            suppressionReason: input.suppressionReason,
            createdAt: new Date(input.now),
            updatedAt: new Date(input.now),
          };
      this.reminders.set(key, record);
      return cloneEventReminderIntent(record);
    }));
  }

  async cancelReminderIntents(eventId: string, userId?: string, now = new Date()): Promise<void> {
    await this.exclusive(() => {
      for (const reminder of this.reminders.values()) {
        if (reminder.eventId !== eventId || (userId && reminder.userId !== userId)) continue;
        reminder.status = 'CANCELLED';
        reminder.suppressionReason = 'REGISTRATION_CANCELLED';
        reminder.updatedAt = new Date(now);
      }
    });
  }

  async listReminderIntents(
    eventId: string,
    userId?: string,
  ): Promise<EventReminderIntent[]> {
    return [...this.reminders.values()]
      .filter((reminder) => reminder.eventId === eventId && (!userId || reminder.userId === userId))
      .sort((left, right) => left.scheduledFor.getTime() - right.scheduledFor.getTime() || left.id.localeCompare(right.id))
      .map(cloneEventReminderIntent);
  }

  async recordAttendance(
    input: RecordEventAttendanceInput,
  ): Promise<EventAttendanceResult> {
    return this.exclusive(() => {
      const key = registrationKey(input.eventId, input.userId);
      const existing = this.attendance.get(key);
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) {
          throw new EventAttendanceReplayConflictError();
        }
        return { record: cloneEventAttendance(existing), replayed: true };
      }
      const record: EventAttendanceRecord = {
        id: randomUUID(),
        eventId: input.eventId,
        userId: input.userId,
        evidenceType: input.evidenceType,
        evidenceId: input.evidenceId,
        markedByUserId: input.markedByUserId,
        occurredAt: new Date(input.occurredAt),
        fingerprint: input.fingerprint,
        createdAt: new Date(input.now),
        updatedAt: new Date(input.now),
      };
      this.attendance.set(key, record);
      return { record: cloneEventAttendance(record), replayed: false };
    });
  }

  async findAttendance(
    eventId: string,
    userId: string,
  ): Promise<EventAttendanceRecord | null> {
    const record = this.attendance.get(registrationKey(eventId, userId));
    return record ? cloneEventAttendance(record) : null;
  }

  private countRegistered(eventId: string): number {
    return [...this.registrations.values()]
      .filter((record) => record.eventId === eventId && record.status === 'REGISTERED')
      .length;
  }

  private nextWaitlistPosition(eventId: string): number {
    return [...this.registrations.values()]
      .filter((record) => record.eventId === eventId && record.status === 'WAITLISTED')
      .length + 1;
  }

  private rebalance(
    eventId: string,
    capacity: number,
    now: Date,
  ): EventRegistrationRecord[] {
    const promoted: EventRegistrationRecord[] = [];
    const active = this.countRegistered(eventId);
    const slots = Math.max(0, Math.min(capacity - active, Number.MAX_SAFE_INTEGER));
    const waitlisted = [...this.registrations.values()]
      .filter((record) => record.eventId === eventId && record.status === 'WAITLISTED')
      .sort(compareRegistration);
    for (const record of waitlisted.slice(0, slots)) {
      record.status = 'REGISTERED';
      record.waitlistPosition = null;
      record.updatedAt = new Date(now);
      promoted.push(record);
    }
    [...this.registrations.values()]
      .filter((record) => record.eventId === eventId && record.status === 'WAITLISTED')
      .sort(compareRegistration)
      .forEach((record, index) => {
        record.waitlistPosition = index + 1;
        record.updatedAt = new Date(now);
      });
    return promoted;
  }

  private async exclusive<T>(operation: () => T): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }
}

function registrationKey(eventId: string, userId: string): string {
  return `${eventId}:${userId}`;
}

function invitationKey(eventId: string, userId: string): string {
  return registrationKey(eventId, userId);
}

function reminderKey(
  eventId: string,
  userId: string,
  kind: EventReminderIntent['kind'],
): string {
  return `${eventId}:${userId}:${kind}`;
}

function compareRegistration(
  left: EventRegistrationRecord,
  right: EventRegistrationRecord,
): number {
  return left.registeredAt.getTime() - right.registeredAt.getTime() || left.id.localeCompare(right.id);
}

function cloneInvitation(record: EventInvitationRecord): EventInvitationRecord {
  return {
    ...record,
    invitedAt: new Date(record.invitedAt),
    revokedAt: record.revokedAt ? new Date(record.revokedAt) : null,
    updatedAt: new Date(record.updatedAt),
  };
}
