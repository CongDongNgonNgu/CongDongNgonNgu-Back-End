import {
  EVENT_RECURRENCE_FREQUENCIES,
  EVENT_VENUE_TYPES,
  EVENT_VISIBILITIES,
  EVENT_WEEKDAYS,
  type EventRecurrenceDefinition,
  type EventRecord,
  type EventStatus,
  type EventVenueType,
  type EventVisibility,
  type EventWeekday,
} from './event.types';

export const MAX_EVENT_TITLE_LENGTH = 160;
export const MAX_EVENT_TOPIC_LENGTH = 160;
export const MAX_EVENT_CAPACITY = 1_000;
export const MAX_RECURRENCE_INTERVAL = 30;
export const MAX_RECURRENCE_COUNT = 100;
export const MAX_RECURRENCE_WINDOW_MS = 730 * 24 * 60 * 60 * 1_000;

export interface CreateEventDefinitionInput {
  hostUserId: string;
  title: string;
  languageCode: string;
  level?: string | null;
  topic?: string | null;
  startAt: Date;
  endAt: Date;
  timezone: string;
  capacity: number;
  visibility?: EventVisibility;
  venueType: EventVenueType;
  speakingRoomId?: string | null;
  recurrence?: EventRecurrenceDefinition | null;
  createdAt: Date;
}

export interface NormalizedEventDefinition extends Omit<
  EventRecord,
  'id' | 'recurrenceSeriesId' | 'status' | 'cancelledAt' | 'cancelledByUserId'
> {
  recurrenceSeriesId?: string | null;
  status?: EventStatus;
  cancelledAt?: Date | null;
  cancelledByUserId?: string | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LANGUAGE_CODE_PATTERN = /^[a-z]{2,35}$/u;
const LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);

export function normalizeEventDefinition(
  input: CreateEventDefinitionInput,
): NormalizedEventDefinition {
  if (!UUID_PATTERN.test(input.hostUserId))
    throw new Error('Event host is invalid');
  const title = normalizeText(
    input.title,
    3,
    MAX_EVENT_TITLE_LENGTH,
    'Event title is invalid',
  );
  const languageCode =
    typeof input.languageCode === 'string'
      ? input.languageCode.trim().toLowerCase()
      : '';
  if (!LANGUAGE_CODE_PATTERN.test(languageCode))
    throw new Error('Event language is invalid');

  const level =
    input.level === undefined || input.level === null
      ? null
      : input.level.trim().toUpperCase();
  if (level !== null && !LEVELS.has(level))
    throw new Error('Event level is invalid');
  const topic =
    input.topic === undefined || input.topic === null
      ? null
      : normalizeText(
          input.topic,
          1,
          MAX_EVENT_TOPIC_LENGTH,
          'Event topic is invalid',
        );

  if (
    !isValidDate(input.startAt) ||
    !isValidDate(input.endAt) ||
    input.endAt.getTime() <= input.startAt.getTime()
  ) {
    throw new Error('Event schedule is invalid');
  }
  if (!isIanaTimezone(input.timezone))
    throw new Error('Event timezone is invalid');
  if (
    !Number.isSafeInteger(input.capacity) ||
    input.capacity < 1 ||
    input.capacity > MAX_EVENT_CAPACITY
  ) {
    throw new Error('Event capacity is invalid');
  }

  const visibility = input.visibility ?? 'PUBLIC';
  if (!EVENT_VISIBILITIES.includes(visibility))
    throw new Error('Event visibility is invalid');
  if (!EVENT_VENUE_TYPES.includes(input.venueType))
    throw new Error('Event venue is invalid');

  const speakingRoomId = input.speakingRoomId ?? null;
  if (input.venueType === 'SPEAKING_ROOM') {
    if (!speakingRoomId || !UUID_PATTERN.test(speakingRoomId)) {
      throw new Error('Speaking room is required');
    }
  } else if (speakingRoomId !== null) {
    throw new Error('Speaking room is not valid for this venue');
  }

  if (!isValidDate(input.createdAt))
    throw new Error('Event creation time is invalid');
  return {
    hostUserId: input.hostUserId,
    title,
    languageCode,
    level,
    topic,
    startAt: new Date(input.startAt),
    endAt: new Date(input.endAt),
    timezone: input.timezone.trim(),
    capacity: input.capacity,
    visibility,
    venueType: input.venueType,
    speakingRoomId,
    recurrence: normalizeRecurrence(input.recurrence, input.endAt),
    createdAt: new Date(input.createdAt),
    updatedAt: new Date(input.createdAt),
  };
}

export function getEventState(
  event: Pick<EventRecord, 'status' | 'startAt' | 'endAt'>,
  now: Date,
): 'UPCOMING' | 'LIVE' | 'ENDED' | 'CANCELLED' {
  if (event.status === 'CANCELLED') return 'CANCELLED';
  if (now.getTime() < event.startAt.getTime()) return 'UPCOMING';
  if (now.getTime() >= event.endAt.getTime()) return 'ENDED';
  return 'LIVE';
}

function normalizeRecurrence(
  value: EventRecurrenceDefinition | null | undefined,
  endAt: Date,
): EventRecurrenceDefinition | null {
  if (value === undefined || value === null) return null;
  if (!EVENT_RECURRENCE_FREQUENCIES.includes(value.frequency)) {
    throw new Error('Event recurrence frequency is invalid');
  }
  if (
    !Number.isSafeInteger(value.interval) ||
    value.interval < 1 ||
    value.interval > MAX_RECURRENCE_INTERVAL
  ) {
    throw new Error('Event recurrence interval is invalid');
  }
  const count = value.count ?? null;
  const until = value.until ?? null;
  if ((count === null) === (until === null)) {
    throw new Error('Event recurrence must have exactly one bound');
  }
  if (
    count !== null &&
    (!Number.isSafeInteger(count) || count < 2 || count > MAX_RECURRENCE_COUNT)
  ) {
    throw new Error('Event recurrence count is invalid');
  }
  if (until !== null) {
    if (!isValidDate(until) || until.getTime() <= endAt.getTime()) {
      throw new Error('Event recurrence end is invalid');
    }
    if (until.getTime() - endAt.getTime() > MAX_RECURRENCE_WINDOW_MS) {
      throw new Error('Event recurrence window is too long');
    }
  }
  const byWeekday = [...new Set(value.byWeekday ?? [])];
  if (byWeekday.some((day) => !EVENT_WEEKDAYS.includes(day))) {
    throw new Error('Event recurrence weekday is invalid');
  }
  if (value.frequency !== 'WEEKLY' && byWeekday.length > 0) {
    throw new Error('Event recurrence weekdays require weekly frequency');
  }
  return {
    frequency: value.frequency,
    interval: value.interval,
    count,
    until: until ? new Date(until) : null,
    byWeekday: byWeekday as EventWeekday[],
  };
}

function normalizeText(
  value: string,
  min: number,
  max: number,
  message: string,
): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < min || normalized.length > max)
    throw new Error(message);
  return normalized;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isIanaTimezone(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.trim().length > 64
  )
    return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format();
    return true;
  } catch {
    return false;
  }
}
