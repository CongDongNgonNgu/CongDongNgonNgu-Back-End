import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  @ApiProperty({ type: String, enum: Array.from(EVENT_RECURRENCE_FREQUENCIES) })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(EVENT_RECURRENCE_FREQUENCIES)
  frequency!: EventRecurrenceFrequency;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  interval?: number;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 2, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(100)
  count?: number;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time' })
  @IsOptional()
  @IsISO8601()
  until?: string;

  @ApiPropertyOptional({ type: String, isArray: true, nullable: true, enum: Array.from(EVENT_WEEKDAYS), uniqueItems: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(EVENT_WEEKDAYS, { each: true })
  byWeekday?: EventWeekday[];
}

export class CreateEventDto {
  @ApiProperty({ type: String, minLength: 3, maxLength: 160 })
  @IsString()
  @Length(3, 160)
  title!: string;

  @ApiProperty({ type: String, minLength: 2, maxLength: 35 })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Length(2, 35)
  languageCode!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 8 })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MaxLength(8)
  level?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 1, maxLength: 160 })
  @IsOptional()
  @IsString()
  @Length(1, 160)
  topic?: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  @IsISO8601()
  startAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @IsISO8601()
  endAt!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 64 })
  @IsString()
  @Length(1, 64)
  timezone!: string;

  @ApiProperty({ type: Number, format: 'int32', minimum: 1, maximum: 1_000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000)
  capacity!: number;

  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(EVENT_VISIBILITIES) })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(EVENT_VISIBILITIES)
  visibility?: EventVisibility;

  @ApiProperty({ type: String, enum: Array.from(EVENT_VENUE_TYPES) })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(EVENT_VENUE_TYPES)
  venueType!: EventVenueType;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  speakingRoomId?: string | null;

  @ApiPropertyOptional({ type: () => EventRecurrenceDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => EventRecurrenceDto)
  recurrence?: EventRecurrenceDto | null;
}

export class ListEventsQueryDto {
  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(EVENT_STATES) })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(EVENT_STATES)
  state?: EventStateFilter;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 2, maxLength: 35 })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Length(2, 35)
  languageCode?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class InviteEventUserDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  userId!: string;
}

export class MarkEventAttendanceDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  userId!: string;
}
