import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
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

export class CreateCorrectionRequestDto {
  @ApiProperty({ type: String, minLength: 2, maxLength: 35 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  languageCode!: string;

  @ApiProperty({ type: String, maxLength: 20_000 })
  @IsString()
  @MaxLength(20_000)
  originalText!: string;

  @ApiProperty({ type: String, maxLength: 32 })
  @IsString()
  @MaxLength(32)
  correctionIntent!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5_000 })
  @IsOptional()
  @IsString()
  @MaxLength(5_000)
  context?: string | null;

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

export class CreateQuestionDto {
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

export class CreateStructuredResponseDto {
  @ApiProperty({ type: String, maxLength: 32 })
  @IsString()
  @MaxLength(32)
  responseKind!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 20_000 })
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  correctedText?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 20_000 })
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  answerText?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5_000 })
  @IsOptional()
  @IsString()
  @MaxLength(5_000)
  explanation?: string | null;
}

export class ListStructuredResponsesQueryDto {
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

export class AcceptStructuredResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  responseId!: string;
}
