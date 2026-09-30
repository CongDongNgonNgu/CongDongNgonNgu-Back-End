import { IsBoolean, IsIn, IsObject, IsOptional, IsString, Length, MaxLength, Matches } from 'class-validator';
import { AI_CONVERSATION_MAX_TURN_LENGTH, AI_CONVERSATION_MODES } from './ai.conversation.contracts';

export class CreateAiConversationDto {
  @IsIn(AI_CONVERSATION_MODES)
  mode!: string;

  @IsOptional()
  @IsString()
  @Length(2, 35)
  @Matches(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i)
  targetLanguageCode?: string;

  @IsOptional()
  @IsString()
  @Length(2, 35)
  @Matches(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i)
  responseLanguageCode?: string;

  @IsOptional()
  @IsObject()
  roleplay?: Record<string, unknown>;
}

export class CreateAiConversationTurnDto {
  @IsOptional()
  @IsString()
  @Length(1, AI_CONVERSATION_MAX_TURN_LENGTH)
  message?: string;

  @IsOptional()
  @IsBoolean()
  retry?: boolean;
}

export class ExplainAiConversationDto {
  @IsString()
  @MaxLength(80)
  messageId!: string;
}
