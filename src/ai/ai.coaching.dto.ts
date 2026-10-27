import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import {
  AI_COACHING_CORRECTION_STYLES,
  AI_COACHING_EXPLANATION_LANGUAGES,
  AI_COACHING_MAX_CONTEXT_TEXT_LENGTH,
  AI_COACHING_MAX_TEXT_LENGTH,
} from './ai.coaching.contracts';

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

export class AiWritingCoachDto {
  @ApiPropertyOptional({ type: String, nullable: true, minLength: 2, maxLength: 35, pattern: (LANGUAGE_CODE_PATTERN).source })
  @IsOptional()
  @IsString()
  @Length(2, 35)
  @Matches(LANGUAGE_CODE_PATTERN)
  targetLanguageCode?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: AI_COACHING_MAX_CONTEXT_TEXT_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(AI_COACHING_MAX_CONTEXT_TEXT_LENGTH)
  writingTask?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: AI_COACHING_MAX_CONTEXT_TEXT_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(AI_COACHING_MAX_CONTEXT_TEXT_LENGTH)
  goal?: string;

  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(AI_COACHING_CORRECTION_STYLES) })
  @IsOptional()
  @IsIn(AI_COACHING_CORRECTION_STYLES)
  correctionStyle?: string;

  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(AI_COACHING_EXPLANATION_LANGUAGES) })
  @IsOptional()
  @IsIn(AI_COACHING_EXPLANATION_LANGUAGES)
  explanationLanguage?: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: AI_COACHING_MAX_TEXT_LENGTH })
  @IsString()
  @Length(1, AI_COACHING_MAX_TEXT_LENGTH)
  text!: string;
}

export class AiGrammarCoachDto {
  @ApiPropertyOptional({ type: String, nullable: true, minLength: 2, maxLength: 35, pattern: (LANGUAGE_CODE_PATTERN).source })
  @IsOptional()
  @IsString()
  @Length(2, 35)
  @Matches(LANGUAGE_CODE_PATTERN)
  targetLanguageCode?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: AI_COACHING_MAX_CONTEXT_TEXT_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(AI_COACHING_MAX_CONTEXT_TEXT_LENGTH)
  grammarFocus?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: AI_COACHING_MAX_CONTEXT_TEXT_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(AI_COACHING_MAX_CONTEXT_TEXT_LENGTH)
  goal?: string;

  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(AI_COACHING_EXPLANATION_LANGUAGES) })
  @IsOptional()
  @IsIn(AI_COACHING_EXPLANATION_LANGUAGES)
  explanationLanguage?: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: AI_COACHING_MAX_TEXT_LENGTH })
  @IsString()
  @Length(1, AI_COACHING_MAX_TEXT_LENGTH)
  text!: string;
}
