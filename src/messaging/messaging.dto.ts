import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export class OpenDirectConversationDto {
  @IsUUID('4') partnerUserId!: string;
}

class MessagePageDto {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt() @Min(1) @Max(50)
  limit?: number;
}

export class ConversationListDto extends MessagePageDto {
  @IsOptional() @IsString() @MaxLength(512)
  cursor?: string;
}

export class MessageHistoryDto extends MessagePageDto {
  @IsOptional() @IsString() @MaxLength(512)
  before?: string;

  @IsOptional() @IsString() @MaxLength(512)
  after?: string;
}

export class SendDirectMessageDto {
  @IsUUID() clientMessageId!: string;
  // Normalize NFC/trim before counting4000 code points in the domain boundary.
  // The native bounded JSON body parser caps raw wire input.
  @IsString() text!: string;
}

export class MarkDirectMessageReadDto {
  @IsString() @Matches(/^(0|[1-9][0-9]{0,18})$/)
  sequence!: string;
}

// No stream credentials, cursor or other input is accepted in query parameters.
export class MessageStreamQueryDto {}
