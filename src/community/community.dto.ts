import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreatePostDto {
  @IsString()
  @MaxLength(32)
  postType!: string;

  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  languageCode!: string;

  @IsString()
  @MaxLength(20_000)
  content!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  cefrLevel?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  topic?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  visibility?: string;
}

export class UpdatePostDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  postType?: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  languageCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  content?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  cefrLevel?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  topic?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  visibility?: string;
}

export class ListPostsQueryDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class CreateCommentDto {
  @IsString()
  @MaxLength(5_000)
  content!: string;

  @IsOptional()
  @IsUUID('4')
  parentCommentId?: string | null;
}

export class UpdateCommentDto {
  @IsString()
  @MaxLength(5_000)
  content!: string;
}

export class ListCommentsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class ReactionDto {
  @IsString()
  @MaxLength(16)
  type!: string;
}

export class ReportDto {
  @IsString()
  @MaxLength(16)
  targetType!: string;

  @IsUUID('4')
  targetId!: string;

  @IsString()
  @MaxLength(32)
  category!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  details?: string | null;
}

export class SavedPostsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
