import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY_REPOSITORY } from '../identity/identity.module';
import type { IdentityRepository } from '../identity/identity.repository';
import { PROFILE_REPOSITORY } from '../profile/profile.repository';
import type { ProfileRepository } from '../profile/profile.repository';
import {
  SPEAKING_ROOM_REPOSITORY,
  type SpeakingRoomRepository,
} from '../rooms/room.repository';
import { EventFailure } from './event.errors';
import type { CreateEventDto, ListEventsQueryDto } from './event.dto';
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
      throw new EventFailure('EVENT_NOT_FOUND', 404, 'Event is not available');
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
