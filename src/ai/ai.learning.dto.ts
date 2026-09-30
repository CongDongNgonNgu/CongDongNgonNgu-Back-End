import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { AI_LEARNING_MAX_GOAL_LENGTH } from './ai.learning.contracts';

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

export class AiLearningDto {
  @IsString()
  @Length(1, 128)
  resourceId!: string;

  @IsOptional()
  @IsString()
  @Length(2, 35)
  @Matches(LANGUAGE_CODE_PATTERN)
  targetLanguageCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(AI_LEARNING_MAX_GOAL_LENGTH)
  goal?: string;
}
