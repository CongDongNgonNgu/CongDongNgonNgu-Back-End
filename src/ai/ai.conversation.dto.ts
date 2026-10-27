import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, Length, MaxLength, Matches } from 'class-validator';
import { AI_CONVERSATION_MAX_TURN_LENGTH, AI_CONVERSATION_MODES } from './ai.conversation.contracts';

export class CreateAiConversationDto {
  @ApiProperty({ type: String, enum: Array.from(AI_CONVERSATION_MODES) })
  @IsIn(AI_CONVERSATION_MODES)
  mode!: string;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 2, maxLength: 35, pattern: (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i).source })
  @IsOptional()
  @IsString()
  @Length(2, 35)
  @Matches(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i)
  targetLanguageCode?: string;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 2, maxLength: 35, pattern: (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i).source })
  @IsOptional()
  @IsString()
  @Length(2, 35)
  @Matches(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i)
  responseLanguageCode?: string;

  @ApiPropertyOptional({ type: Object, nullable: true })
  @IsOptional()
  @IsObject()
  roleplay?: Record<string, unknown>;
}

export class CreateAiConversationTurnDto {
  @ApiPropertyOptional({ type: String, nullable: true, minLength: 1, maxLength: AI_CONVERSATION_MAX_TURN_LENGTH })
  @IsOptional()
  @IsString()
  @Length(1, AI_CONVERSATION_MAX_TURN_LENGTH)
  message?: string;

  @ApiPropertyOptional({ type: Boolean, nullable: true })
  @IsOptional()
  @IsBoolean()
  retry?: boolean;
}

export class ExplainAiConversationDto {
  @ApiProperty({ type: String, maxLength: 80 })
  @IsString()
  @MaxLength(80)
  messageId!: string;
}
