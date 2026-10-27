import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LIBRARY_RELATION_TYPES } from './library-relations.types';
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
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: LIBRARY_SEARCH_MAX_QUERY_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(LIBRARY_SEARCH_MAX_QUERY_LENGTH)
  q?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 35, pattern: (/^[a-z0-9]+(?:-[a-z0-9]+)*$/i).source })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i)
  @MaxLength(35)
  language?: string;

  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(LIBRARY_RESOURCE_TYPES) })
  @IsOptional()
  @IsIn(LIBRARY_RESOURCE_TYPES)
  type?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  topic?: string;

  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(COMMUNITY_CEFR_LEVELS) })
  @IsOptional()
  @IsIn(COMMUNITY_CEFR_LEVELS)
  level?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: LIBRARY_SEARCH_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIBRARY_SEARCH_MAX_LIMIT)
  limit?: number;
}

export class ListLibraryReviewsDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: LIBRARY_SEARCH_MAX_QUERY_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(LIBRARY_SEARCH_MAX_QUERY_LENGTH)
  q?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 35, pattern: (/^[a-z0-9]+(?:-[a-z0-9]+)*$/i).source })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i)
  @MaxLength(35)
  language?: string;

  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(LIBRARY_RESOURCE_TYPES) })
  @IsOptional()
  @IsIn(LIBRARY_RESOURCE_TYPES)
  type?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: LIBRARY_SEARCH_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIBRARY_SEARCH_MAX_LIMIT)
  limit?: number;
}

export class ListInvalidLibrarySourcesDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: LIBRARY_SEARCH_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIBRARY_SEARCH_MAX_LIMIT)
  limit?: number;
}

export class CreateLibraryResourceDto {
  @ApiProperty({ type: String, maxLength: 32 })
  @IsString()
  @MaxLength(32)
  resourceType!: string;

  @ApiProperty({ type: String, minLength: 2, maxLength: 35 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  primaryLanguageCode!: string;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 2, maxLength: 35 })
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  secondaryLanguageCode?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 8 })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  cefrLevel?: string | null;

  @ApiPropertyOptional({ type: String, isArray: true, nullable: true, maxLength: 80, maxItems: 20 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  topics?: string[];

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 16 })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  visibility?: string;

  @ApiProperty({ type: Object })
  @IsObject()
  details!: Record<string, unknown>;
}

export class IntegrateLibraryCandidateDto extends CreateLibraryResourceDto {
  @ApiProperty({ type: String, maxLength: 80 })
  @IsString()
  @MaxLength(80)
  licenseKey!: string;

  @ApiProperty({ type: String, maxLength: 2_000 })
  @IsString()
  @MaxLength(2_000)
  attribution!: string;
}

export class AttachLibraryProvenanceDto {
  @ApiProperty({ type: String, maxLength: 64 })
  @IsString()
  @MaxLength(64)
  sourceType!: string;

  @ApiProperty({ type: String, maxLength: 255 })
  @IsString()
  @MaxLength(255)
  sourceId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uri', maxLength: 2048 })
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  sourceUrl?: string | null;

  @ApiProperty({ type: String, maxLength: 80 })
  @IsString()
  @MaxLength(80)
  licenseKey!: string;

  @ApiProperty({ type: String, maxLength: 2_000 })
  @IsString()
  @MaxLength(2_000)
  attribution!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  originalAuthorReference?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  importBatch?: string | null;

  @ApiPropertyOptional({ type: Object, isArray: true, nullable: true, maxItems: 50 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsObject({ each: true })
  transformationHistory?: Record<string, unknown>[];

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  sourcePostId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  sourceResponseId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  sourceCandidateId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  sourceAcceptanceId?: string | null;
}

export class TransitionLibraryReviewDto {
  @ApiProperty({ type: String, maxLength: 32 })
  @IsString()
  @MaxLength(32)
  nextState!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2_000 })
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string | null;
}

export class ReconcileLibrarySourceDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2_000 })
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string | null;
}

export class SubmitLibraryContributionDto {
  @ApiProperty({ type: String, maxLength: 80 })
  @IsString()
  @MaxLength(80)
  termsVersion!: string;

  @ApiProperty({ type: Boolean })
  @IsBoolean()
  rightsConfirmed!: boolean;

  @ApiProperty({ type: Boolean })
  @IsBoolean()
  reuseConsent!: boolean;
}

export class RelatedLibraryResourcesDto {
  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(LIBRARY_RELATION_TYPES) })
  @IsOptional() @IsIn(LIBRARY_RELATION_TYPES) relation?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 35, pattern: (/^[a-z0-9]+(?:-[a-z0-9]+)*$/i).source })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i)
  @MaxLength(35)
  language?: string;
  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(LIBRARY_RESOURCE_TYPES) })
  @IsOptional() @IsIn(LIBRARY_RESOURCE_TYPES) type?: string;
  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(COMMUNITY_CEFR_LEVELS) })
  @IsOptional() @IsIn(COMMUNITY_CEFR_LEVELS) level?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 512 })
  @IsOptional() @IsString() @MaxLength(512) cursor?: string;
  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 12 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(12) limit?: number;
}
