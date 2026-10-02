import type { EventRecord } from './event.types';
import { getEventState } from './event.rules';

export type EventPublicState = ReturnType<typeof getEventState>;

export interface EventPublicSummary {
  readonly id: string;
  readonly hostUserId: string;
  readonly title: string;
  readonly languageCode: string;
  readonly level: string | null;
  readonly topic: string | null;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly timezone: string;
  readonly capacity: number;
  readonly visibility: EventRecord['visibility'];
  readonly venueType: EventRecord['venueType'];
  readonly speakingRoomId: string | null;
  readonly recurrenceSeriesId: string | null;
  readonly recurrence: EventRecord['recurrence'];
  readonly status: EventRecord['status'];
  readonly cancelledAt: Date | null;
  readonly state: EventPublicState;
  readonly isHost: boolean;
}

export const EVENT_PUBLIC_STATES = [
  'UPCOMING',
  'LIVE',
  'ENDED',
  'CANCELLED',
] as const;

export function toPublicEvent(
  event: EventRecord,
  viewerUserId: string | null,
  now: Date,
): EventPublicSummary {
  return {
    id: event.id,
    hostUserId: event.hostUserId,
    title: event.title,
    languageCode: event.languageCode,
    level: event.level,
    topic: event.topic,
    startAt: new Date(event.startAt),
    endAt: new Date(event.endAt),
    timezone: event.timezone,
    capacity: event.capacity,
    visibility: event.visibility,
    venueType: event.venueType,
    speakingRoomId: event.speakingRoomId,
    recurrenceSeriesId: event.recurrenceSeriesId,
    recurrence: cloneRecurrence(event.recurrence),
    status: event.status,
    cancelledAt: event.cancelledAt ? new Date(event.cancelledAt) : null,
    state: getEventState(event, now),
    isHost: viewerUserId === event.hostUserId,
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
