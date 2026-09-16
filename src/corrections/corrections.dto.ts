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
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  languageCode!: string;

  @IsString()
  @MaxLength(20_000)
  originalText!: string;

  @IsString()
  @MaxLength(32)
  correctionIntent!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5_000)
  context?: string | null;

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

export class CreateQuestionDto {
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

export class CreateStructuredResponseDto {
  @IsString()
  @MaxLength(32)
  responseKind!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  correctedText?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  answerText?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(5_000)
  explanation?: string | null;
}

export class ListStructuredResponsesQueryDto {
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

export class AcceptStructuredResponseDto {
  @IsUUID('4')
  responseId!: string;
}
