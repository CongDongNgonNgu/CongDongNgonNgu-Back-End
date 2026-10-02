export const EVENT_VISIBILITIES = ['PUBLIC', 'PRIVATE'] as const;
export type EventVisibility = (typeof EVENT_VISIBILITIES)[number];

export const EVENT_VENUE_TYPES = [
  'SPEAKING_ROOM',
  'EXTERNAL',
  'PHYSICAL',
] as const;
export type EventVenueType = (typeof EVENT_VENUE_TYPES)[number];

export const EVENT_STATUSES = ['SCHEDULED', 'CANCELLED'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_RECURRENCE_FREQUENCIES = [
  'DAILY',
  'WEEKLY',
  'MONTHLY',
] as const;
export type EventRecurrenceFrequency =
  (typeof EVENT_RECURRENCE_FREQUENCIES)[number];

export const EVENT_WEEKDAYS = [
  'MO',
  'TU',
  'WE',
  'TH',
  'FR',
  'SA',
  'SU',
] as const;
export type EventWeekday = (typeof EVENT_WEEKDAYS)[number];

export interface EventRecurrenceDefinition {
  frequency: EventRecurrenceFrequency;
  interval: number;
  count: number | null;
  until: Date | null;
  byWeekday: EventWeekday[];
}

export interface EventRecord {
  id: string;
  hostUserId: string;
  title: string;
  languageCode: string;
  level: string | null;
  topic: string | null;
  startAt: Date;
  endAt: Date;
  timezone: string;
  capacity: number;
  visibility: EventVisibility;
  venueType: EventVenueType;
  speakingRoomId: string | null;
  recurrenceSeriesId: string | null;
  recurrence: EventRecurrenceDefinition | null;
  status: EventStatus;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
