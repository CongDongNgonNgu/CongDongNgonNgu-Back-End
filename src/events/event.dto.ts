import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  EVENT_RECURRENCE_FREQUENCIES,
  EVENT_VENUE_TYPES,
  EVENT_VISIBILITIES,
  EVENT_WEEKDAYS,
  type EventRecurrenceFrequency,
  type EventVenueType,
  type EventVisibility,
  type EventWeekday,
} from './event.types';

const EVENT_STATES = ['ALL', 'UPCOMING', 'LIVE', 'ENDED', 'CANCELLED'] as const;
export type EventStateFilter = (typeof EVENT_STATES)[number];

export class EventRecurrenceDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(EVENT_RECURRENCE_FREQUENCIES)
  frequency!: EventRecurrenceFrequency;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  interval?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(100)
  count?: number;

  @IsOptional()
  @IsISO8601()
  until?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(EVENT_WEEKDAYS, { each: true })
  byWeekday?: EventWeekday[];
}

export class CreateEventDto {
  @IsString()
  @Length(3, 160)
  title!: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Length(2, 35)
  languageCode!: string;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MaxLength(8)
  level?: string | null;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  topic?: string | null;

  @IsISO8601()
  startAt!: string;

  @IsISO8601()
  endAt!: string;

  @IsString()
  @Length(1, 64)
  timezone!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000)
  capacity!: number;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(EVENT_VISIBILITIES)
  visibility?: EventVisibility;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(EVENT_VENUE_TYPES)
  venueType!: EventVenueType;

  @IsOptional()
  @IsUUID('4')
  speakingRoomId?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => EventRecurrenceDto)
  recurrence?: EventRecurrenceDto | null;
}

export class ListEventsQueryDto {
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(EVENT_STATES)
  state?: EventStateFilter;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Length(2, 35)
  languageCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class InviteEventUserDto {
  @IsUUID('4')
  userId!: string;
}

export class MarkEventAttendanceDto {
  @IsUUID('4')
  userId!: string;
}
