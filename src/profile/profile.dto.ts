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
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  @Matches(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/)
  languageCode!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsIn(LANGUAGE_ROLES, { each: true })
  roles!: string[];

  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsIn(DECLARED_PROFICIENCIES)
  declaredProficiency!: string;

  @IsOptional()
  @IsBoolean()
  isPrimaryLearningTarget?: boolean;

  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsOptional()
  @IsIn(['PUBLIC', 'PRIVATE'])
  visibility?: string;
}

export class ProfileAvailabilityDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek!: number;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  startTime!: string;

  @IsString()
  @Matches(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/)
  endTime!: string;
}

export class ProfileUpdateDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsOptional()
  @IsString()
  @Length(2, 120)
  @Matches(/\S/)
  displayName?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ProfileLanguageDto)
  languages?: ProfileLanguageDto[];

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

  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(14)
  @ValidateNested({ each: true })
  @Type(() => ProfileAvailabilityDto)
  availability?: ProfileAvailabilityDto[];
}

export class LanguageCatalogQueryDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
