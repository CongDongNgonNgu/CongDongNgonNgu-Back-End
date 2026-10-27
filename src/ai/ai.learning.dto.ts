import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { AI_LEARNING_MAX_GOAL_LENGTH } from './ai.learning.contracts';

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

export class AiLearningDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 128 })
  @IsString()
  @Length(1, 128)
  resourceId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 2, maxLength: 35, pattern: (LANGUAGE_CODE_PATTERN).source })
  @IsOptional()
  @IsString()
  @Length(2, 35)
  @Matches(LANGUAGE_CODE_PATTERN)
  targetLanguageCode?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: AI_LEARNING_MAX_GOAL_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(AI_LEARNING_MAX_GOAL_LENGTH)
  goal?: string;
}
