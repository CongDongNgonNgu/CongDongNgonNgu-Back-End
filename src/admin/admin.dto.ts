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
  @IsOptional()
  @IsEnum(COMMUNITY_REPORT_STATES)
  state?: typeof COMMUNITY_REPORT_STATES[number];

  @IsOptional()
  @IsEnum(COMMUNITY_REPORT_TARGET_TYPES)
  targetType?: typeof COMMUNITY_REPORT_TARGET_TYPES[number];

  @IsOptional()
  @IsUUID('4')
  assignedToUserId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class AdminAssignReportDto {
  @IsOptional()
  @IsUUID('4')
  assignedToUserId?: string | null;
}

export class AdminResolveReportDto {
  @IsEnum(COMMUNITY_REPORT_STATES)
  state!: typeof COMMUNITY_REPORT_STATES[number];

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  reason?: string | null;
}

export class AdminReportNoteDto {
  @IsString()
  @MaxLength(2_000)
  body!: string;
}

export class AdminContentActionDto {
  @IsEnum(['HIDE', 'REMOVE', 'RESTORE'] as const)
  action!: 'HIDE' | 'REMOVE' | 'RESTORE';

  @IsString()
  @MaxLength(1_000)
  reason!: string;
}

export class AdminUserActionDto {
  @IsEnum(['WARN', 'SUSPEND', 'RESTORE'] as const)
  action!: 'WARN' | 'SUSPEND' | 'RESTORE';

  @IsString()
  @MaxLength(1_000)
  reason!: string;
}

export class AdminReplaceRolesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(ROLE_KEYS.length)
  @ArrayUnique()
  @IsEnum(ROLE_KEYS, { each: true })
  roles!: RoleKey[];
}

export class AdminUsersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsEnum(USER_STATUSES)
  status?: typeof USER_STATUSES[number];

  @IsOptional()
  @IsEnum(ROLE_KEYS)
  role?: RoleKey;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  offset?: number;
}

export class AdminReverseReputationDto {
  @IsString()
  @MaxLength(1_000)
  reason!: string;

  @IsString()
  @MaxLength(200)
  idempotencyKey!: string;
}

export class AdminAuditQueryDto {
  @IsOptional()
  @IsUUID('4')
  actorUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  targetId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  offset?: number;
}
