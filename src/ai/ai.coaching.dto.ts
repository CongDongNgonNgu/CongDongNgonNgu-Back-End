import { IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import {
  AI_COACHING_CORRECTION_STYLES,
  AI_COACHING_EXPLANATION_LANGUAGES,
  AI_COACHING_MAX_CONTEXT_TEXT_LENGTH,
  AI_COACHING_MAX_TEXT_LENGTH,
} from './ai.coaching.contracts';

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

export class AiWritingCoachDto {
  @IsOptional()
  @IsString()
  @Length(2, 35)
  @Matches(LANGUAGE_CODE_PATTERN)
  targetLanguageCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(AI_COACHING_MAX_CONTEXT_TEXT_LENGTH)
  writingTask?: string;

  @IsOptional()
  @IsString()
  @MaxLength(AI_COACHING_MAX_CONTEXT_TEXT_LENGTH)
  goal?: string;

  @IsOptional()
  @IsIn(AI_COACHING_CORRECTION_STYLES)
  correctionStyle?: string;

  @IsOptional()
  @IsIn(AI_COACHING_EXPLANATION_LANGUAGES)
  explanationLanguage?: string;

  @IsString()
  @Length(1, AI_COACHING_MAX_TEXT_LENGTH)
  text!: string;
}

export class AiGrammarCoachDto {
  @IsOptional()
  @IsString()
  @Length(2, 35)
  @Matches(LANGUAGE_CODE_PATTERN)
  targetLanguageCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(AI_COACHING_MAX_CONTEXT_TEXT_LENGTH)
  grammarFocus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(AI_COACHING_MAX_CONTEXT_TEXT_LENGTH)
  goal?: string;

  @IsOptional()
  @IsIn(AI_COACHING_EXPLANATION_LANGUAGES)
  explanationLanguage?: string;

  @IsString()
  @Length(1, AI_COACHING_MAX_TEXT_LENGTH)
  text!: string;
}
