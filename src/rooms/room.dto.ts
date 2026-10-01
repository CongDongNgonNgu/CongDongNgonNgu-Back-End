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

const VISIBILITIES = ['PUBLIC', 'PRIVATE'] as const;
const LIFECYCLES = ['LIVE', 'SCHEDULED'] as const;

export class CreateSpeakingRoomDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  languageCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  level?: string | null;

  @IsString()
  @Length(1, 160)
  topic!: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsIn(VISIBILITIES)
  visibility?: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsIn(LIFECYCLES)
  lifecycle?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(100)
  capacity?: number;

  @IsOptional()
  @IsISO8601()
  scheduledAt?: string | null;
}

export class ListSpeakingRoomsQueryDto {
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
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

export class IssueMediaSessionDto {
  @IsUUID('4')
  requestId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  accessToken?: string;
}

export class JoinSpeakingRoomDto {
  @IsUUID('4')
  requestId!: string;

  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 128)
  deviceId!: string;

  @IsOptional()
  @IsUUID('4')
  participantId?: string | null;
}

const LEAVE_MODES = ['VOLUNTARY', 'DISCONNECT'] as const;

export class LeaveSpeakingRoomDto {
  @IsUUID('4')
  requestId!: string;

  @IsUUID('4')
  participantId!: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsIn(LEAVE_MODES)
  mode?: string;
}

export class HeartbeatSpeakingRoomDto {
  @IsUUID('4')
  requestId!: string;

  @IsUUID('4')
  participantId!: string;
}
