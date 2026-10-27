import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsISO8601,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SPEAKING_ROOM_REPORT_CATEGORIES } from './room.interaction.types';

const VISIBILITIES = ['PUBLIC', 'PRIVATE'] as const;
const LIFECYCLES = ['LIVE', 'SCHEDULED'] as const;

export class CreateSpeakingRoomDto {
  @ApiProperty({ type: String, minLength: 2, maxLength: 35 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  languageCode!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 8 })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  level?: string | null;

  @ApiProperty({ type: String, minLength: 1, maxLength: 160 })
  @IsString()
  @Length(1, 160)
  topic!: string;

  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(VISIBILITIES) })
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsIn(VISIBILITIES)
  visibility?: string;

  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(LIFECYCLES) })
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsIn(LIFECYCLES)
  lifecycle?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 2, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(100)
  capacity?: number;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time' })
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string | null;
}

export class ListSpeakingRoomsQueryDto {
  @ApiPropertyOptional({ type: String, nullable: true, minLength: 2, maxLength: 35 })
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
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

export class IssueMediaSessionDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  requestId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 256, writeOnly: true })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  accessToken?: string;
}

export class JoinSpeakingRoomDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  requestId!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 128 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 128)
  deviceId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  participantId?: string | null;
}

const LEAVE_MODES = ['VOLUNTARY', 'DISCONNECT'] as const;

export class LeaveSpeakingRoomDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  requestId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  participantId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(LEAVE_MODES) })
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsIn(LEAVE_MODES)
  mode?: string;
}

export class HeartbeatSpeakingRoomDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  requestId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  participantId!: string;
}

export class SpeakingRoomActionDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  requestId!: string;
}

const QUEUE_DECISIONS = ['ACCEPT', 'DECLINE'] as const;

export class SpeakingRoomQueueDecisionDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  requestId!: string;

  @ApiProperty({ type: String, enum: Array.from(QUEUE_DECISIONS) })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsIn(QUEUE_DECISIONS)
  decision!: string;
}

export class SpeakingRoomMuteDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  requestId!: string;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 3_600 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3_600)
  durationSeconds?: number;
}

export class SpeakingRoomReportDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  requestId!: string;

  @ApiProperty({ type: String, enum: Array.from(SPEAKING_ROOM_REPORT_CATEGORIES) })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsIn(SPEAKING_ROOM_REPORT_CATEGORIES)
  category!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1_000 })
  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  details?: string | null;
}

export class SpeakingRoomChatMessageDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  requestId!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 1_000 })
  @IsString()
  @Length(1, 1_000)
  content!: string;
}

export class SpeakingRoomChatQueryDto {
  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
