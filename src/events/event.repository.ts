import { randomUUID } from 'node:crypto';
import type { EventPublicState } from './event.public';
import type { NormalizedEventDefinition } from './event.rules';
import type { EventRecord } from './event.types';

export const EVENT_REPOSITORY = 'EVENT_REPOSITORY';

export class EventRepositoryConflictError extends Error {
  constructor(message = 'Event data conflicts with existing data') {
    super(message);
    this.name = 'EventRepositoryConflictError';
  }
}

export class EventRepositoryNotFoundError extends Error {
  constructor(message = 'Event data was not found') {
    super(message);
    this.name = 'EventRepositoryNotFoundError';
  }
}

export class EventRepositoryHostError extends Error {
  constructor(message = 'Event host is not allowed to change this event') {
    super(message);
    this.name = 'EventRepositoryHostError';
  }
}

export interface CreateEventRepositoryInput extends NormalizedEventDefinition {}

export interface EventListQuery {
  languageCode?: string;
  state?: EventPublicState | 'ALL';
  now?: Date;
  limit: number;
}

export interface CancelEventResult {
  record: EventRecord;
  replayed: boolean;
}

export interface EventRepository {
  createEvent(input: CreateEventRepositoryInput): Promise<EventRecord>;
  findEventById(id: string): Promise<EventRecord | null>;
  listPublicEvents(query: EventListQuery): Promise<EventRecord[]>;
  cancelEvent(
    eventId: string,
    hostUserId: string,
    now: Date,
  ): Promise<CancelEventResult>;
}

export class InMemoryEventRepository implements EventRepository {
  private readonly events = new Map<string, EventRecord>();

  async createEvent(input: CreateEventRepositoryInput): Promise<EventRecord> {
    const now = new Date(input.createdAt);
    const record: EventRecord = {
      id: randomUUID(),
      hostUserId: input.hostUserId,
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
      recurrenceSeriesId: input.recurrence ? randomUUID() : null,
      recurrence: cloneRecurrence(input.recurrence),
      status: 'SCHEDULED',
      cancelledAt: null,
      cancelledByUserId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.events.set(record.id, record);
    return cloneEvent(record);
  }

  async findEventById(id: string): Promise<EventRecord | null> {
    const record = this.events.get(id);
    return record ? cloneEvent(record) : null;
  }

  async listPublicEvents(query: EventListQuery): Promise<EventRecord[]> {
    return [...this.events.values()]
      .filter((event) => event.visibility === 'PUBLIC')
      .filter(
        (event) =>
          !query.languageCode || event.languageCode === query.languageCode,
      )
      .filter(
        (event) =>
          !query.state ||
          query.state === 'ALL' ||
          deriveState(event, query.now ?? new Date()) === query.state,
      )
      .sort(
        (left, right) =>
          left.startAt.getTime() - right.startAt.getTime() ||
          left.id.localeCompare(right.id),
      )
      .slice(0, query.limit)
      .map(cloneEvent);
  }

  async cancelEvent(
    eventId: string,
    hostUserId: string,
    now: Date,
  ): Promise<CancelEventResult> {
    const event = this.events.get(eventId);
    if (!event) throw new EventRepositoryNotFoundError('Event does not exist');
    if (event.hostUserId !== hostUserId) throw new EventRepositoryHostError();
    if (event.status === 'CANCELLED')
      return { record: cloneEvent(event), replayed: true };
    event.status = 'CANCELLED';
    event.cancelledAt = new Date(now);
    event.cancelledByUserId = hostUserId;
    event.updatedAt = new Date(now);
    return { record: cloneEvent(event), replayed: false };
  }
}

function deriveState(event: EventRecord, now: Date): EventPublicState {
  if (event.status === 'CANCELLED') return 'CANCELLED';
  if (now.getTime() < event.startAt.getTime()) return 'UPCOMING';
  if (now.getTime() >= event.endAt.getTime()) return 'ENDED';
  return 'LIVE';
}

function cloneEvent(event: EventRecord): EventRecord {
  return {
    ...event,
    startAt: new Date(event.startAt),
    endAt: new Date(event.endAt),
    recurrence: cloneRecurrence(event.recurrence),
    cancelledAt: event.cancelledAt ? new Date(event.cancelledAt) : null,
    createdAt: new Date(event.createdAt),
    updatedAt: new Date(event.updatedAt),
  };
}

function cloneRecurrence(
  recurrence: EventRecord['recurrence'],
): EventRecord['recurrence'] {
  return recurrence
    ? {
        ...recurrence,
        until: recurrence.until ? new Date(recurrence.until) : null,
        byWeekday: [...recurrence.byWeekday],
      }
    : null;
}
