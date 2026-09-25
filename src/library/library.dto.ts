import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  LIBRARY_RESOURCE_TYPES,
  LIBRARY_SEARCH_MAX_LIMIT,
  LIBRARY_SEARCH_MAX_QUERY_LENGTH,
} from './library.types';
import { COMMUNITY_CEFR_LEVELS } from '../community/community.types';

export class SearchLibraryResourcesDto {
  @IsOptional()
  @IsString()
  @MaxLength(LIBRARY_SEARCH_MAX_QUERY_LENGTH)
  q?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i)
  @MaxLength(35)
  language?: string;

  @IsOptional()
  @IsIn(LIBRARY_RESOURCE_TYPES)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  topic?: string;

  @IsOptional()
  @IsIn(COMMUNITY_CEFR_LEVELS)
  level?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIBRARY_SEARCH_MAX_LIMIT)
  limit?: number;
}

export class ListLibraryReviewsDto {
  @IsOptional()
  @IsString()
  @MaxLength(LIBRARY_SEARCH_MAX_QUERY_LENGTH)
  q?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i)
  @MaxLength(35)
  language?: string;

  @IsOptional()
  @IsIn(LIBRARY_RESOURCE_TYPES)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIBRARY_SEARCH_MAX_LIMIT)
  limit?: number;
}

export class ListInvalidLibrarySourcesDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIBRARY_SEARCH_MAX_LIMIT)
  limit?: number;
}

export class CreateLibraryResourceDto {
  @IsString()
  @MaxLength(32)
  resourceType!: string;

  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  primaryLanguageCode!: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  secondaryLanguageCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  cefrLevel?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  topics?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(16)
  visibility?: string;

  @IsObject()
  details!: Record<string, unknown>;
}

export class AttachLibraryProvenanceDto {
  @IsString()
  @MaxLength(64)
  sourceType!: string;

  @IsString()
  @MaxLength(255)
  sourceId!: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  sourceUrl?: string | null;

  @IsString()
  @MaxLength(80)
  licenseKey!: string;

  @IsString()
  @MaxLength(2_000)
  attribution!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  originalAuthorReference?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  importBatch?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsObject({ each: true })
  transformationHistory?: Record<string, unknown>[];

  @IsOptional()
  @IsUUID('4')
  sourcePostId?: string | null;

  @IsOptional()
  @IsUUID('4')
  sourceResponseId?: string | null;

  @IsOptional()
  @IsUUID('4')
  sourceCandidateId?: string | null;

  @IsOptional()
  @IsUUID('4')
  sourceAcceptanceId?: string | null;
}

export class TransitionLibraryReviewDto {
  @IsString()
  @MaxLength(32)
  nextState!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string | null;
}

export class ReconcileLibrarySourceDto {
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string | null;
}

export class SubmitLibraryContributionDto {
  @IsString()
  @MaxLength(80)
  termsVersion!: string;

  @IsBoolean()
  rightsConfirmed!: boolean;

  @IsBoolean()
  reuseConsent!: boolean;
}
