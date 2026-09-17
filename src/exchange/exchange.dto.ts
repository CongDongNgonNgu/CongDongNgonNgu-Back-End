import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsString,
  MaxLength,
  Matches,
  ValidateIf,
} from 'class-validator';
import {
  EXCHANGE_CEFR_LEVELS,
  EXCHANGE_CONTACT_PERMISSIONS,
  EXCHANGE_VISIBILITY_MODES,
} from './exchange.types';

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

function normalizeArray(
  value: unknown,
  normalize: (item: unknown) => unknown,
): unknown {
  return Array.isArray(value) ? value.map(normalize) : value;
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
