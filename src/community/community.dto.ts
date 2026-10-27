import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  @ApiProperty({ type: String, maxLength: 32 })
  @IsString()
  @MaxLength(32)
  postType!: string;

  @ApiProperty({ type: String, minLength: 2, maxLength: 35 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  languageCode!: string;

  @ApiProperty({ type: String, maxLength: 20_000 })
  @IsString()
  @MaxLength(20_000)
  content!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 8 })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  cefrLevel?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  topic?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 16 })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  visibility?: string;
}

export class UpdatePostDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  postType?: string;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 2, maxLength: 35 })
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  languageCode?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 20_000 })
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  content?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 8 })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  cefrLevel?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  topic?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 16 })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  visibility?: string;
}

export class ListPostsQueryDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 240 })
  @IsOptional() @IsString() @MaxLength(240) q?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 32 })
  @IsOptional() @IsString() @MaxLength(32) postType?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 160 })
  @IsOptional() @IsString() @MaxLength(160) topic?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 16 })
  @IsOptional() @IsString() @MaxLength(16) responseState?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5 })
  @IsOptional() @IsString() @MaxLength(5) savedByMe?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 8 })
  @IsOptional() @IsString() @MaxLength(8) sort?: string;
  @ApiPropertyOptional({ type: String, nullable: true, minLength: 2, maxLength: 35 })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Length(2, 35)
  languageCode?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  cursor?: string;
}

export class CreateCommentDto {
  @ApiProperty({ type: String, maxLength: 5_000 })
  @IsString()
  @MaxLength(5_000)
  content!: string;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  parentCommentId?: string | null;
}

export class UpdateCommentDto {
  @ApiProperty({ type: String, maxLength: 5_000 })
  @IsString()
  @MaxLength(5_000)
  content!: string;
}

export class ListCommentsQueryDto {
  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class ReactionDto {
  @ApiProperty({ type: String, maxLength: 16 })
  @IsString()
  @MaxLength(16)
  type!: string;
}

export class ReportDto {
  @ApiProperty({ type: String, maxLength: 16 })
  @IsString()
  @MaxLength(16)
  targetType!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  targetId!: string;

  @ApiProperty({ type: String, maxLength: 32 })
  @IsString()
  @MaxLength(32)
  category!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1_000 })
  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  details?: string | null;
}

export class SavedPostsQueryDto {
  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
