import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { IDENTITY_REPOSITORY } from '../identity/identity.module';
import type { IdentityRepository } from '../identity/identity.repository';
import { PROFILE_REPOSITORY } from '../profile/profile.repository';
import type { ProfileRepository } from '../profile/profile.repository';
import {
  SPEAKING_ROOM_REPOSITORY,
  type SpeakingRoomRepository,
} from '../rooms/room.repository';
import {
  SPEAKING_ROOM_PARTICIPANT_REPOSITORY,
  type SpeakingRoomParticipantRepository,
} from '../rooms/room.participant.repository';
import { NotificationPreferenceService } from '../notifications/notification-preference.service';
import { EventFailure } from './event.errors';
import type {
  CreateEventDto,
  InviteEventUserDto,
  ListEventsQueryDto,
  MarkEventAttendanceDto,
} from './event.dto';
import {
  toPublicEvent,
  type EventPublicSummary,
  type EventPublicState,
} from './event.public';
import {
  EVENT_REPOSITORY,
  EventRepositoryHostError,
  EventRepositoryNotFoundError,
  type EventRepository,
} from './event.repository';
import {
  EVENT_PARTICIPATION_REPOSITORY,
  EventAttendanceReplayConflictError,
  EventParticipationRepositoryConflictError,
  EventParticipationRepositoryNotFoundError,
  type EventParticipationRepository,
} from './event.participation.repository';
import {
  EVENT_ATTENDANCE_LEARNING_HOOK,
  EVENT_REMINDER_KINDS,
  type EventAttendanceLearningHook,
  type EventAttendanceRecord,
  type EventReminderIntent,
  type EventRegistrationRecord,
  type EventRegistrationResponse,
  toPublicEventRegistration,
} from './event.participation.types';
import {
  normalizeEventDefinition,
  type CreateEventDefinitionInput,
  getEventState,
} from './event.rules';
import { EVENT_PUBLIC_STATES } from './event.public';
import type { EventRecurrenceDefinition, EventRecord } from './event.types';

export interface EventCancelResponse {
  outcome: 'CANCELLED' | 'REPLAYED';
  event: EventPublicSummary;
}

export interface EventRegistrationActionResponse {
  outcome: 'REGISTERED' | 'WAITLISTED' | 'CANCELLED' | 'REPLAYED';
  replayed: boolean;
  registration: EventRegistrationResponse;
  promotedCount: number;
}

export interface EventAttendanceResponse {
  outcome: 'RECORDED' | 'REPLAYED';
  attendance: EventAttendanceRecord;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

@Injectable()
export class EventService {
  constructor(
    @Inject(EVENT_REPOSITORY) private readonly repository: EventRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(IDENTITY_REPOSITORY)
    private readonly identities: IdentityRepository,
    @Inject(SPEAKING_ROOM_REPOSITORY)
    private readonly rooms: SpeakingRoomRepository,
    @Optional()
    @Inject(EVENT_PARTICIPATION_REPOSITORY)
    private readonly participation?: EventParticipationRepository,
    @Optional()
    @Inject(EVENT_ATTENDANCE_LEARNING_HOOK)
    private readonly attendanceHook?: EventAttendanceLearningHook,
    @Optional()
    private readonly notificationPreferences?: NotificationPreferenceService,
    @Optional()
    @Inject(SPEAKING_ROOM_PARTICIPANT_REPOSITORY)
    private readonly roomParticipants?: SpeakingRoomParticipantRepository,
  ) {}

  async createEvent(
    userId: string,
    input: CreateEventDto,
    now = new Date(),
  ): Promise<EventPublicSummary> {
    await this.requireActiveUser(userId);
    if (!isValidDate(now))
      throw new EventFailure(
        'EVENT_INVALID_INPUT',
        400,
        'Event time is invalid',
      );

    let normalized: ReturnType<typeof normalizeEventDefinition>;
    try {
      normalized = normalizeEventDefinition(
        this.toDefinitionInput(userId, input, now),
      );
    } catch {
      throw new EventFailure(
        'EVENT_INVALID_INPUT',
        400,
        'Event definition is invalid',
      );
    }
    if (normalized.startAt.getTime() <= now.getTime()) {
      throw new EventFailure(
        'EVENT_INVALID_INPUT',
        400,
        'Event must start in the future',
      );
    }

    const languages = await this.profiles.findActiveByCodes([
      normalized.languageCode,
    ]);
    if (
      languages.length !== 1 ||
      languages[0].code !== normalized.languageCode
    ) {
      throw new EventFailure(
        'EVENT_LANGUAGE_UNAVAILABLE',
        422,
        'Event language is not available',
      );
    }
    await this.assertVenueCapability(
      userId,
      normalized.venueType,
      normalized.speakingRoomId,
      normalized.visibility,
    );

    try {
      const event = await this.repository.createEvent(normalized);
      return toPublicEvent(event, userId, now);
    } catch {
      throw new EventFailure(
        'EVENT_INVALID_INPUT',
        409,
        'Event could not be created',
      );
    }
  }

  async listPublicEvents(
    input: ListEventsQueryDto = {},
    now = new Date(),
  ): Promise<EventPublicSummary[]> {
    if (!isValidDate(now))
      throw new EventFailure(
        'EVENT_INVALID_INPUT',
        400,
        'Event time is invalid',
      );
    const state = input.state ?? 'ALL';
    if (
      state !== 'ALL' &&
      !EVENT_PUBLIC_STATES.includes(state as EventPublicState)
    ) {
      throw new EventFailure(
        'EVENT_INVALID_INPUT',
        400,
        'Event state is invalid',
      );
    }
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new EventFailure(
        'EVENT_INVALID_INPUT',
        400,
        'Event page size is invalid',
      );
    }
    const languageCode = input.languageCode?.trim().toLowerCase();
    if (languageCode !== undefined && !/^[a-z]{2,35}$/u.test(languageCode)) {
      throw new EventFailure(
        'EVENT_INVALID_INPUT',
        400,
        'Event language is invalid',
      );
    }
    const candidates = await this.repository.listPublicEvents({
      languageCode,
      state,
      now,
      limit: 50,
    });
    return candidates
      .map((event) => toPublicEvent(event, null, now))
      .filter((event) => state === 'ALL' || event.state === state)
      .slice(0, limit);
  }

  async getEvent(
    eventId: string,
    viewerUserId: string | null,
    now = new Date(),
  ): Promise<EventPublicSummary> {
    assertUuid(eventId);
    if (!isValidDate(now))
      throw new EventFailure(
        'EVENT_INVALID_INPUT',
        400,
        'Event time is invalid',
      );
    const event = await this.requireEvent(eventId);
    if (event.visibility === 'PRIVATE' && event.hostUserId !== viewerUserId) {
      const invited = viewerUserId
        ? await this.participation?.hasActiveInvitation(event.id, viewerUserId)
        : false;
      if (!invited) {
        throw new EventFailure('EVENT_NOT_FOUND', 404, 'Event is not available');
      }
    }
    return toPublicEvent(event, viewerUserId, now);
  }

  async cancelEvent(
    eventId: string,
    userId: string,
    now = new Date(),
  ): Promise<EventCancelResponse> {
    assertUuid(eventId);
    await this.requireActiveUser(userId);
    if (!isValidDate(now))
      throw new EventFailure(
        'EVENT_INVALID_INPUT',
        400,
        'Event time is invalid',
      );
    const event = await this.requireEvent(eventId);
    if (event.hostUserId !== userId) {
      throw new EventFailure(
        'EVENT_HOST_FORBIDDEN',
        403,
        'Only the event host can cancel this event',
      );
    }
    if (getEventState(event, now) === 'ENDED') {
      throw new EventFailure(
        'EVENT_CANNOT_CANCEL',
        409,
        'Past events cannot be cancelled',
      );
    }
    try {
      const result = await this.repository.cancelEvent(eventId, userId, now);
      if (this.participation) {
        await this.participation.cancelEventParticipation(eventId, now);
      }
      return {
        outcome: result.replayed ? 'REPLAYED' : 'CANCELLED',
        event: toPublicEvent(result.record, userId, now),
      };
    } catch (error) {
      if (error instanceof EventRepositoryHostError) {
        throw new EventFailure(
          'EVENT_HOST_FORBIDDEN',
          403,
          'Only the event host can cancel this event',
        );
      }
      if (error instanceof EventRepositoryNotFoundError) {
        throw new EventFailure(
          'EVENT_NOT_FOUND',
          404,
          'Event is not available',
        );
      }
      throw new EventFailure(
        'EVENT_INVALID_INPUT',
        500,
        'Event cancellation failed',
      );
    }
  }

  async inviteEventUser(
    eventId: string,
    hostUserId: string,
    input: InviteEventUserDto,
    now = new Date(),
  ): Promise<{ outcome: 'INVITED' | 'REPLAYED'; userId: string }> {
    assertUuid(eventId);
    await this.requireActiveUser(hostUserId);
    await this.requireActiveUser(input.userId);
    const event = await this.requireEvent(eventId);
    if (event.visibility !== 'PRIVATE' || event.hostUserId !== hostUserId) {
      throw new EventFailure(
        'EVENT_INVITE_FORBIDDEN',
        403,
        'Only the private-event host can manage invitations',
      );
    }
    if (input.userId === hostUserId) {
      throw new EventFailure(
        'EVENT_INVALID_INPUT',
        400,
        'The event host does not need an invitation',
      );
    }
    const participation = this.requireParticipation();
    try {
      const result = await participation.inviteUser(
        eventId,
        input.userId,
        hostUserId,
        now,
      );
      return {
        outcome: result.replayed ? 'REPLAYED' : 'INVITED',
        userId: input.userId,
      };
    } catch (error) {
      throw this.mapParticipationError(error, 'Event invitation failed');
    }
  }

  async getRegistration(
    eventId: string,
    userId: string,
    now = new Date(),
  ): Promise<EventRegistrationResponse> {
    assertUuid(eventId);
    await this.requireActiveUser(userId);
    const event = await this.requireEvent(eventId);
    await this.assertEventViewerAccess(event, userId);
    const record = await this.requireParticipation().findRegistration(eventId, userId);
    if (!record) {
      throw new EventFailure(
        'EVENT_REGISTRATION_NOT_FOUND',
        404,
        'Event registration is not available',
      );
    }
    if (!isValidDate(now)) {
      throw new EventFailure('EVENT_INVALID_INPUT', 400, 'Event time is invalid');
    }
    return toPublicEventRegistration(record);
  }

  async revokeEventInvitation(
    eventId: string,
    hostUserId: string,
    invitedUserId: string,
    now = new Date(),
  ): Promise<{ outcome: 'REVOKED' | 'REPLAYED'; userId: string }> {
    assertUuid(eventId);
    assertUuid(invitedUserId);
    await this.requireActiveUser(hostUserId);
    const event = await this.requireEvent(eventId);
    if (event.visibility !== 'PRIVATE' || event.hostUserId !== hostUserId) {
      throw new EventFailure(
        'EVENT_INVITE_FORBIDDEN',
        403,
        'Only the private-event host can manage invitations',
      );
    }
    const participation = this.requireParticipation();
    try {
      const result = await participation.revokeInvitation(
        eventId,
        invitedUserId,
        hostUserId,
        now,
      );
      if (!result.replayed) {
        const registration = await participation.findRegistration(eventId, invitedUserId);
        if (registration && registration.status !== 'CANCELLED') {
          const cancellation = await participation.cancelRegistration(event, invitedUserId, now);
          await participation.cancelReminderIntents(eventId, invitedUserId, now);
          for (const promoted of cancellation.promoted) {
            await this.syncReminderIntents(event, promoted, now);
          }
        }
      }
      return {
        outcome: result.replayed ? 'REPLAYED' : 'REVOKED',
        userId: invitedUserId,
      };
    } catch (error) {
      throw this.mapParticipationError(error, 'Event invitation revocation failed');
    }
  }

  async registerEvent(
    eventId: string,
    userId: string,
    now = new Date(),
  ): Promise<EventRegistrationActionResponse> {
    assertUuid(eventId);
    await this.requireActiveUser(userId);
    if (!isValidDate(now)) {
      throw new EventFailure('EVENT_INVALID_INPUT', 400, 'Event time is invalid');
    }
    const event = await this.requireEvent(eventId);
    if (event.hostUserId === userId) {
      throw new EventFailure(
        'EVENT_HOST_CANNOT_REGISTER',
        409,
        'The event host cannot register as an attendee',
      );
    }
    if (getEventState(event, now) !== 'UPCOMING') {
      throw new EventFailure(
        'EVENT_REGISTRATION_NOT_AVAILABLE',
        409,
        'This event is no longer accepting registrations',
      );
    }
    await this.assertEventViewerAccess(event, userId);
    const participation = this.requireParticipation();
    try {
      const result = await participation.registerEvent(event, userId, now);
      if (result.record.status === 'REGISTERED') {
        await this.syncReminderIntents(event, result.record, now);
      } else {
        await participation.cancelReminderIntents(event.id, userId, now);
      }
      for (const promoted of result.promoted) {
        await this.syncReminderIntents(event, promoted, now);
      }
      return {
        outcome: result.replayed
          ? 'REPLAYED'
          : result.record.status === 'WAITLISTED'
            ? 'WAITLISTED'
            : 'REGISTERED',
        replayed: result.replayed,
        registration: toPublicEventRegistration(result.record),
        promotedCount: result.promoted.length,
      };
    } catch (error) {
      throw this.mapParticipationError(error, 'Event registration failed');
    }
  }

  async cancelRegistration(
    eventId: string,
    userId: string,
    now = new Date(),
  ): Promise<EventRegistrationActionResponse> {
    assertUuid(eventId);
    await this.requireActiveUser(userId);
    if (!isValidDate(now)) {
      throw new EventFailure('EVENT_INVALID_INPUT', 400, 'Event time is invalid');
    }
    const event = await this.requireEvent(eventId);
    await this.assertEventViewerAccess(event, userId);
    const participation = this.requireParticipation();
    try {
      const result = await participation.cancelRegistration(event, userId, now);
      await participation.cancelReminderIntents(event.id, userId, now);
      for (const promoted of result.promoted) {
        await this.syncReminderIntents(event, promoted, now);
      }
      return {
        outcome: result.replayed ? 'REPLAYED' : 'CANCELLED',
        replayed: result.replayed,
        registration: toPublicEventRegistration(result.record),
        promotedCount: result.promoted.length,
      };
    } catch (error) {
      throw this.mapParticipationError(error, 'Event registration cancellation failed');
    }
  }

  async reconcileEventReminders(
    eventId: string,
    userId: string,
    now = new Date(),
  ): Promise<EventReminderIntent[]> {
    assertUuid(eventId);
    await this.requireActiveUser(userId);
    if (!isValidDate(now)) {
      throw new EventFailure('EVENT_INVALID_INPUT', 400, 'Event time is invalid');
    }
    const event = await this.requireEvent(eventId);
    await this.assertEventViewerAccess(event, userId);
    const registration = await this.requireParticipation().findRegistration(eventId, userId);
    if (!registration || registration.status !== 'REGISTERED') {
      throw new EventFailure(
        'EVENT_REMINDER_INVALID',
        409,
        'Only a registered attendee can receive event reminders',
      );
    }
    return this.syncReminderIntents(event, registration, now);
  }

  async getEventReminders(
    eventId: string,
    userId: string,
  ): Promise<EventReminderIntent[]> {
    assertUuid(eventId);
    await this.requireActiveUser(userId);
    const event = await this.requireEvent(eventId);
    await this.assertEventViewerAccess(event, userId);
    return this.requireParticipation().listReminderIntents(eventId, userId);
  }

  async markEventAttendance(
    eventId: string,
    hostUserId: string,
    input: MarkEventAttendanceDto,
    now = new Date(),
  ): Promise<EventAttendanceResponse> {
    assertUuid(eventId);
    await this.requireActiveUser(hostUserId);
    await this.requireActiveUser(input.userId);
    if (!isValidDate(now)) {
      throw new EventFailure('EVENT_INVALID_INPUT', 400, 'Event time is invalid');
    }
    const event = await this.requireEvent(eventId);
    if (event.hostUserId !== hostUserId) {
      throw new EventFailure(
        'EVENT_ATTENDANCE_FORBIDDEN',
        403,
        'Only the event host can mark attendance',
      );
    }
    if (event.status === 'CANCELLED' || getEventState(event, now) === 'UPCOMING') {
      throw new EventFailure(
        'EVENT_ATTENDANCE_INVALID',
        409,
        'Attendance can only be recorded after the event starts',
      );
    }
    const registration = await this.requireParticipation().findRegistration(eventId, input.userId);
    if (!registration || registration.status !== 'REGISTERED') {
      throw new EventFailure(
        'EVENT_ATTENDANCE_NOT_FOUND',
        409,
        'Only a registered attendee can be marked present',
      );
    }
    const occurredAt = now.getTime() > event.endAt.getTime() ? event.endAt : now;
    return this.recordAttendance(
      event,
      input.userId,
      'HOST_MARKED',
      `host:${hostUserId}:${input.userId}`,
      hostUserId,
      occurredAt,
      now,
    );
  }

  async recordSystemAttendance(
    eventId: string,
    input: {
      userId: string;
      roomId: string;
      participantId: string;
      occurredAt: Date;
    },
    now = new Date(),
  ): Promise<EventAttendanceResponse> {
    assertUuid(eventId);
    assertUuid(input.userId);
    assertUuid(input.roomId);
    assertUuid(input.participantId);
    if (!isValidDate(now) || !isValidDate(input.occurredAt)) {
      throw new EventFailure('EVENT_INVALID_INPUT', 400, 'Attendance time is invalid');
    }
    const event = await this.requireEvent(eventId);
    if (
      event.status === 'CANCELLED' ||
      event.venueType !== 'SPEAKING_ROOM' ||
      event.speakingRoomId !== input.roomId ||
      input.occurredAt.getTime() < event.startAt.getTime() ||
      input.occurredAt.getTime() > event.endAt.getTime() ||
      input.occurredAt.getTime() > now.getTime()
    ) {
      throw new EventFailure(
        'EVENT_ATTENDANCE_INVALID',
        409,
        'Room attendance evidence is not valid for this event',
      );
    }
    const participant = await this.roomParticipants?.findParticipant(
      input.roomId,
      input.participantId,
      now,
    );
    if (!participant || participant.userId !== input.userId || participant.state === 'REMOVED') {
      throw new EventFailure(
        'EVENT_ATTENDANCE_INVALID',
        409,
        'Room presence evidence is not available',
      );
    }
    const registration = await this.requireParticipation().findRegistration(eventId, input.userId);
    if (!registration || registration.status !== 'REGISTERED') {
      throw new EventFailure(
        'EVENT_ATTENDANCE_NOT_FOUND',
        409,
        'Only a registered attendee can receive attendance credit',
      );
    }
    return this.recordAttendance(
      event,
      input.userId,
      'ROOM_PRESENCE',
      `room:${input.roomId}:participant:${input.participantId}`,
      null,
      input.occurredAt,
      now,
    );
  }

  private async recordAttendance(
    event: EventRecord,
    userId: string,
    evidenceType: EventAttendanceRecord['evidenceType'],
    evidenceId: string,
    markedByUserId: string | null,
    occurredAt: Date,
    now: Date,
  ): Promise<EventAttendanceResponse> {
    let result;
    try {
      result = await this.requireParticipation().recordAttendance({
        eventId: event.id,
        userId,
        evidenceType,
        evidenceId,
        markedByUserId,
        occurredAt,
        fingerprint: createHash('sha256')
          .update(`${event.id}:${userId}:${evidenceType}:${evidenceId}:${occurredAt.toISOString()}`)
          .digest('hex'),
        now,
      });
    } catch (error) {
      throw this.mapParticipationError(error, 'Attendance could not be recorded');
    }
    if (!result.replayed) {
      await this.attendanceHook?.recordTrustedAttendance({
        eventId: event.id,
        userId,
        languageCode: event.languageCode,
        evidenceType,
        evidenceId,
        occurredAt,
      });
    }
    return {
      outcome: result.replayed ? 'REPLAYED' : 'RECORDED',
      attendance: result.record,
    };
  }

  private async syncReminderIntents(
    event: EventRecord,
    registration: EventRegistrationRecord,
    now: Date,
  ): Promise<EventReminderIntent[]> {
    const profile = await this.profiles.findProfile(registration.userId);
    const recipientTimezone = profile.timezone ?? event.timezone;
    const inAppEnabled = this.notificationPreferences
      ? await this.notificationPreferences.isChannelEnabled(registration.userId, {
          category: 'COMMUNITY',
          channel: 'IN_APP',
          notificationType: 'EVENT_REMINDER',
        })
      : true;
    const offsets: Readonly<Record<(typeof EVENT_REMINDER_KINDS)[number], number>> = {
      TWENTY_FOUR_HOURS: 24 * 60 * 60 * 1_000,
      ONE_HOUR: 60 * 60 * 1_000,
    };
    return this.requireParticipation().upsertReminderIntents(
      EVENT_REMINDER_KINDS.map((kind) => {
        const scheduledFor = new Date(event.startAt.getTime() - offsets[kind]);
        const suppressionReason = scheduledFor.getTime() <= now.getTime()
          ? 'REMINDER_WINDOW_PASSED'
          : !inAppEnabled
            ? 'IN_APP_PREFERENCE'
            : null;
        return {
          eventId: event.id,
          userId: registration.userId,
          registrationId: registration.id,
          kind,
          scheduledFor,
          recipientTimezone,
          status: suppressionReason ? 'SUPPRESSED' as const : 'SCHEDULED' as const,
          suppressionReason,
          now,
        };
      }),
    );
  }

  private async assertEventViewerAccess(
    event: EventRecord,
    viewerUserId: string,
  ): Promise<void> {
    if (event.visibility === 'PUBLIC' || event.hostUserId === viewerUserId) return;
    const invited = await this.participation?.hasActiveInvitation(event.id, viewerUserId);
    if (!invited) {
      throw new EventFailure('EVENT_INVITE_REQUIRED', 404, 'Event invitation is required');
    }
  }

  private requireParticipation(): EventParticipationRepository {
    if (!this.participation) {
      throw new EventFailure(
        'EVENT_INTERNAL_ERROR',
        500,
        'Event participation persistence is unavailable',
      );
    }
    return this.participation;
  }

  private mapParticipationError(error: unknown, fallback: string): EventFailure {
    if (error instanceof EventParticipationRepositoryNotFoundError) {
      return new EventFailure('EVENT_REGISTRATION_NOT_FOUND', 404, 'Event participation is not available');
    }
    if (error instanceof EventAttendanceReplayConflictError) {
      return new EventFailure(
        'EVENT_ATTENDANCE_REPLAY_CONFLICT',
        409,
        'Attendance evidence conflicts with the existing record',
      );
    }
    if (error instanceof EventParticipationRepositoryConflictError) {
      return new EventFailure('EVENT_REGISTRATION_CONFLICT', 409, fallback);
    }
    return error instanceof EventFailure
      ? error
      : new EventFailure('EVENT_INTERNAL_ERROR', 500, fallback);
  }

  private async assertVenueCapability(
    userId: string,
    venueType: CreateEventDefinitionInput['venueType'],
    speakingRoomId: string | null,
    visibility: CreateEventDefinitionInput['visibility'],
  ): Promise<void> {
    if (venueType !== 'SPEAKING_ROOM') {
      throw new EventFailure(
        'EVENT_VENUE_UNSUPPORTED',
        422,
        'This venue type is not enabled for event access yet',
      );
    }
    const room = await this.rooms.findRoomById(speakingRoomId!);
    if (!room)
      throw new EventFailure(
        'EVENT_SPEAKING_ROOM_NOT_FOUND',
        404,
        'Speaking room is not available',
      );
    if (room.hostUserId !== userId) {
      throw new EventFailure(
        'EVENT_SPEAKING_ROOM_HOST_FORBIDDEN',
        403,
        'Only the speaking-room host can schedule an event for that room',
      );
    }
    if (room.lifecycle === 'CANCELLED' || room.lifecycle === 'ENDED') {
      throw new EventFailure(
        'EVENT_SPEAKING_ROOM_UNAVAILABLE',
        409,
        'Speaking room is not available for scheduling',
      );
    }
    if (room.visibility === 'PRIVATE' && visibility !== 'PRIVATE') {
      throw new EventFailure(
        'EVENT_SPEAKING_ROOM_UNAVAILABLE',
        409,
        'A private speaking room requires a private event',
      );
    }
  }

  private async requireEvent(eventId: string): Promise<EventRecord> {
    const event = await this.repository.findEventById(eventId);
    if (!event)
      throw new EventFailure('EVENT_NOT_FOUND', 404, 'Event is not available');
    return event;
  }

  private async requireActiveUser(userId: string): Promise<void> {
    if (!UUID_PATTERN.test(userId))
      throw new EventFailure(
        'EVENT_ACTOR_INVALID',
        401,
        'Event actor is invalid',
      );
    const user = await this.identities.findUserById(userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new EventFailure(
        'EVENT_ACTOR_INVALID',
        403,
        'Event actor is not active',
      );
    }
  }

  private toDefinitionInput(
    userId: string,
    input: CreateEventDto,
    now: Date,
  ): CreateEventDefinitionInput {
    const recurrence: EventRecurrenceDefinition | null = input.recurrence
      ? {
          frequency: input.recurrence.frequency,
          interval: input.recurrence.interval ?? 1,
          count: input.recurrence.count ?? null,
          until: input.recurrence.until
            ? new Date(input.recurrence.until)
            : null,
          byWeekday: input.recurrence.byWeekday
            ? [...input.recurrence.byWeekday]
            : [],
        }
      : null;
    return {
      hostUserId: userId,
      title: input.title,
      languageCode: input.languageCode,
      level: input.level,
      topic: input.topic,
      startAt: new Date(input.startAt),
      endAt: new Date(input.endAt),
      timezone: input.timezone,
      capacity: input.capacity,
      visibility: input.visibility,
      venueType: input.venueType,
      speakingRoomId: input.speakingRoomId,
      recurrence,
      createdAt: now,
    };
  }
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value))
    throw new EventFailure(
      'EVENT_INVALID_INPUT',
      400,
      'Event identifier is invalid',
    );
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
