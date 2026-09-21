import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
  Max,
  ValidateIf,
  Min,
} from 'class-validator';
import {
  EXCHANGE_CEFR_LEVELS,
  EXCHANGE_CONTACT_PERMISSIONS,
  EXCHANGE_TIMEZONE_COMPATIBILITIES,
  EXCHANGE_VISIBILITY_MODES,
} from './exchange.types';
import { EXCHANGE_REPORT_CATEGORIES } from './exchange-safety.types';

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const PROFILE_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class ExchangePreferenceUpdateDto {
  @ValidateIf(({ value }) => value !== undefined)
  @IsBoolean()
  exchangeOptIn?: boolean;

  @ValidateIf(({ value }) => value !== undefined)
  @IsBoolean()
  discoverable?: boolean;

  @Transform(({ value }) => normalizeArray(value, normalizeCode))
  @ValidateIf(({ value }) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(35, { each: true })
  @Matches(LANGUAGE_CODE_PATTERN, { each: true })
  offeredLanguageCodes?: string[];

  @Transform(({ value }) => normalizeArray(value, normalizeCode))
  @ValidateIf(({ value }) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(35, { each: true })
  @Matches(LANGUAGE_CODE_PATTERN, { each: true })
  wantedLanguageCodes?: string[];

  @Transform(({ value }) => normalizeArray(value, normalizeLevel))
  @ValidateIf(({ value }) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(6)
  @ArrayUnique()
  @IsString({ each: true })
  @IsIn(EXCHANGE_CEFR_LEVELS, { each: true })
  preferredPartnerLevels?: string[];

  @Transform(({ value }) => normalizeArray(value, normalizeCode))
  @ValidateIf(({ value }) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @Matches(PROFILE_CODE_PATTERN, { each: true })
  matchingGoalCodes?: string[];

  @Transform(({ value }) => normalizeArray(value, normalizeInterest))
  @ValidateIf(({ value }) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @Matches(/\S/, { each: true })
  matchingInterestCodes?: string[];

  @Transform(({ value }) => normalizeEnum(value))
  @ValidateIf(({ value }) => value !== undefined)
  @IsString()
  @IsIn(EXCHANGE_VISIBILITY_MODES)
  timezoneVisibility?: string;

  @Transform(({ value }) => normalizeEnum(value))
  @ValidateIf(({ value }) => value !== undefined)
  @IsString()
  @IsIn(EXCHANGE_VISIBILITY_MODES)
  availabilityVisibility?: string;

  @Transform(({ value }) => normalizeEnum(value))
  @ValidateIf(({ value }) => value !== undefined)
  @IsString()
  @IsIn(EXCHANGE_CONTACT_PERMISSIONS)
  contactPermission?: string;
}

export class ExchangeDiscoveryQueryDto {
  @Transform(({ value }) => normalizeQueryArray(value, normalizeCode))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(35, { each: true })
  @Matches(LANGUAGE_CODE_PATTERN, { each: true })
  offeredLanguageCodes?: string[];

  @Transform(({ value }) => normalizeQueryArray(value, normalizeCode))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(35, { each: true })
  @Matches(LANGUAGE_CODE_PATTERN, { each: true })
  wantedLanguageCodes?: string[];

  @Transform(({ value }) => normalizeQueryArray(value, normalizeLevel))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ArrayUnique()
  @IsString({ each: true })
  @IsIn(EXCHANGE_CEFR_LEVELS, { each: true })
  preferredPartnerLevels?: string[];

  @Transform(({ value }) => normalizeQueryArray(value, normalizeCode))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @Matches(PROFILE_CODE_PATTERN, { each: true })
  matchingGoalCodes?: string[];

  @Transform(({ value }) => normalizeQueryArray(value, normalizeInterest))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @Matches(/\S/, { each: true })
  matchingInterestCodes?: string[];

  @Transform(({ value }) => normalizeEnum(value))
  @IsOptional()
  @IsString()
  @IsIn(EXCHANGE_TIMEZONE_COMPATIBILITIES)
  timezoneCompatibility?: string;

  @Transform(({ value }) => typeof value === 'string' ? Number(value) : value)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  page?: number;

  @Transform(({ value }) => typeof value === 'string' ? Number(value) : value)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  pageSize?: number;
}

export class ExchangeReportDto {
  @Transform(({ value }) => normalizeEnum(value))
  @IsString()
  @IsIn(EXCHANGE_REPORT_CATEGORIES)
  category!: string;

  @Transform(({ value }) => typeof value === 'string' ? value.normalize('NFKC').trim() : value)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  context?: string;
}

function normalizeArray(
  value: unknown,
  normalize: (item: unknown) => unknown,
): unknown {
  return Array.isArray(value) ? value.map(normalize) : value;
}

function normalizeQueryArray(
  value: unknown,
  normalize: (item: unknown) => unknown,
): unknown {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => (
    typeof item === 'string' ? item.split(',').map(normalize) : [normalize(item)]
  ));
}

function normalizeCode(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

function normalizeLevel(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

function normalizeInterest(value: unknown): unknown {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/\s+/g, ' ')
    : value;
}

function normalizeEnum(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}
