import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const LANGUAGE_ROLES = ['native', 'known', 'learning'] as const;
const DECLARED_PROFICIENCIES = ['NATIVE', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
const PROFILE_SKILLS = [
  'speaking',
  'listening',
  'reading',
  'writing',
  'grammar',
  'vocabulary',
] as const;

export class ProfileLanguageDto {
  @ApiProperty({ type: String, minLength: 2, maxLength: 35, pattern: (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/).source })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  @Matches(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/)
  languageCode!: string;

  @ApiProperty({ type: String, isArray: true, enum: Array.from(LANGUAGE_ROLES), minItems: 1, maxItems: 3, uniqueItems: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsIn(LANGUAGE_ROLES, { each: true })
  roles!: string[];

  @ApiProperty({ type: String, enum: Array.from(DECLARED_PROFICIENCIES) })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsIn(DECLARED_PROFICIENCIES)
  declaredProficiency!: string;

  @ApiPropertyOptional({ type: Boolean, nullable: true })
  @IsOptional()
  @IsBoolean()
  isPrimaryLearningTarget?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(['PUBLIC', 'PRIVATE']) })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsOptional()
  @IsIn(['PUBLIC', 'PRIVATE'])
  visibility?: string;
}

export class ProfileAvailabilityDto {
  @ApiProperty({ type: Number, format: 'int32', minimum: 1, maximum: 7 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek!: number;

  @ApiProperty({ type: String, pattern: (/^([01]\d|2[0-3]):[0-5]\d$/).source })
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  startTime!: string;

  @ApiProperty({ type: String, pattern: (/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/).source })
  @IsString()
  @Matches(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/)
  endTime!: string;
}

export class ProfileUpdateDto {
  @ApiPropertyOptional({ type: String, nullable: true, minLength: 2, maxLength: 120, pattern: (/\S/).source })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsOptional()
  @IsString()
  @Length(2, 120)
  @Matches(/\S/)
  displayName?: string;

  @ApiPropertyOptional({ type: () => ProfileLanguageDto, isArray: true, nullable: true, maxItems: 20 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ProfileLanguageDto)
  languages?: ProfileLanguageDto[];

  @ApiPropertyOptional({ type: String, isArray: true, nullable: true, maxLength: 64, maxItems: 10, uniqueItems: true, pattern: (/^[a-z0-9][a-z0-9_-]{0,63}$/).source })
  @Transform(({ value }) => Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? item.trim().toLowerCase() : item)
    : value)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @Matches(/^[a-z0-9][a-z0-9_-]{0,63}$/, { each: true })
  @ArrayUnique()
  goals?: string[];

  @ApiPropertyOptional({ type: String, isArray: true, nullable: true, enum: Array.from(PROFILE_SKILLS), maxItems: 6, uniqueItems: true })
  @Transform(({ value }) => Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? item.trim().toLowerCase() : item)
    : value)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @IsIn(PROFILE_SKILLS, { each: true })
  @ArrayUnique()
  skills?: string[];

  @ApiPropertyOptional({ type: String, isArray: true, nullable: true, maxLength: 64, maxItems: 20, uniqueItems: true, pattern: (/\S/).source })
  @Transform(({ value }) => Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? item.trim() : item)
    : value)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @Matches(/\S/, { each: true })
  @ArrayUnique()
  interests?: string[];

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 64 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string | null;

  @ApiPropertyOptional({ type: () => ProfileAvailabilityDto, isArray: true, nullable: true, maxItems: 14 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(14)
  @ValidateNested({ each: true })
  @Type(() => ProfileAvailabilityDto)
  availability?: ProfileAvailabilityDto[];
}

export class LanguageCatalogQueryDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 50 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class LanguageHubQueryDto {
  @ApiPropertyOptional({ type: String, isArray: true, nullable: true, maxLength: 16, maxItems: 6 })
  @Transform(({ value }) => normalizeLanguageHubLevels(value))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(16, { each: true })
  level?: string[];

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsOptional()
  @IsString()
  @MaxLength(80)
  topic?: string;
}

export class LanguageSlugParamsDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 64 })
  @IsString()
  @Length(1, 64)
  slug!: string;
}

function normalizeLanguageHubLevels(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => (
    typeof item === 'string'
      ? item.split(',').map((level) => level.trim())
      : [item]
  ));
}
