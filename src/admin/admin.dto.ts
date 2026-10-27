import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  COMMUNITY_REPORT_STATES,
  COMMUNITY_REPORT_TARGET_TYPES,
} from '../community/community.types';
import { ROLE_KEYS } from '../identity/role-policy';
import { USER_STATUSES, type RoleKey } from '../identity/identity.types';

export class AdminReportsQueryDto {
  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(COMMUNITY_REPORT_STATES) })
  @IsOptional()
  @IsEnum(COMMUNITY_REPORT_STATES)
  state?: typeof COMMUNITY_REPORT_STATES[number];

  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(COMMUNITY_REPORT_TARGET_TYPES) })
  @IsOptional()
  @IsEnum(COMMUNITY_REPORT_TARGET_TYPES)
  targetType?: typeof COMMUNITY_REPORT_TARGET_TYPES[number];

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  assignedToUserId?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class AdminAssignReportDto {
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  assignedToUserId?: string | null;
}

export class AdminResolveReportDto {
  @ApiProperty({ type: String, enum: Array.from(COMMUNITY_REPORT_STATES) })
  @IsEnum(COMMUNITY_REPORT_STATES)
  state!: typeof COMMUNITY_REPORT_STATES[number];

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1_000 })
  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  reason?: string | null;
}

export class AdminReportNoteDto {
  @ApiProperty({ type: String, maxLength: 2_000 })
  @IsString()
  @MaxLength(2_000)
  body!: string;
}

export class AdminContentActionDto {
  @ApiProperty({ type: String, enum: ['HIDE', 'REMOVE', 'RESTORE'] })
  @IsEnum(['HIDE', 'REMOVE', 'RESTORE'] as const)
  action!: 'HIDE' | 'REMOVE' | 'RESTORE';

  @ApiProperty({ type: String, maxLength: 1_000 })
  @IsString()
  @MaxLength(1_000)
  reason!: string;
}

export class AdminUserActionDto {
  @ApiProperty({ type: String, enum: ['WARN', 'SUSPEND', 'RESTORE'] })
  @IsEnum(['WARN', 'SUSPEND', 'RESTORE'] as const)
  action!: 'WARN' | 'SUSPEND' | 'RESTORE';

  @ApiProperty({ type: String, maxLength: 1_000 })
  @IsString()
  @MaxLength(1_000)
  reason!: string;
}

export class AdminReplaceRolesDto {
  @ApiProperty({ type: String, isArray: true, enum: Array.from(ROLE_KEYS), minItems: 1, maxItems: ROLE_KEYS.length, uniqueItems: true })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(ROLE_KEYS.length)
  @ArrayUnique()
  @IsEnum(ROLE_KEYS, { each: true })
  roles!: RoleKey[];
}

export class AdminUsersQueryDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(USER_STATUSES) })
  @IsOptional()
  @IsEnum(USER_STATUSES)
  status?: typeof USER_STATUSES[number];

  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(ROLE_KEYS) })
  @IsOptional()
  @IsEnum(ROLE_KEYS)
  role?: RoleKey;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 0, maximum: 100_000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  offset?: number;
}

export class AdminReverseReputationDto {
  @ApiProperty({ type: String, maxLength: 1_000 })
  @IsString()
  @MaxLength(1_000)
  reason!: string;

  @ApiProperty({ type: String, maxLength: 200 })
  @IsString()
  @MaxLength(200)
  idempotencyKey!: string;
}

export class AdminAuditQueryDto {
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  actorUserId?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  targetType?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  targetId?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 0, maximum: 100_000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  offset?: number;
}
