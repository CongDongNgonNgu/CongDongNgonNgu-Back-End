import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export class OpenDirectConversationDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4') partnerUserId!: string;
}

class MessagePageDto {
  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 50 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt() @Min(1) @Max(50)
  limit?: number;
}

export class ConversationListDto extends MessagePageDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 512 })
  @IsOptional() @IsString() @MaxLength(512)
  cursor?: string;
}

export class MessageHistoryDto extends MessagePageDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 512 })
  @IsOptional() @IsString() @MaxLength(512)
  before?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 512 })
  @IsOptional() @IsString() @MaxLength(512)
  after?: string;
}

export class SendDirectMessageDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID() clientMessageId!: string;
  // Normalize NFC/trim before counting4000 code points in the domain boundary.
  // The native bounded JSON body parser caps raw wire input.
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @IsString() text?: string;
  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(['LIBRARY_RESOURCE', 'COMMUNITY_POST']) })
  @IsOptional() @IsIn(['LIBRARY_RESOURCE', 'COMMUNITY_POST']) contextType?: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional() @IsUUID() contextId?: string;
}

export class MarkDirectMessageReadDto {
  @ApiProperty({ type: String, pattern: (/^(0|[1-9][0-9]{0,18})$/).source })
  @IsString() @Matches(/^(0|[1-9][0-9]{0,18})$/)
  sequence!: string;
}

// No stream credentials, cursor or other input is accepted in query parameters.
export class MessageStreamQueryDto {}
