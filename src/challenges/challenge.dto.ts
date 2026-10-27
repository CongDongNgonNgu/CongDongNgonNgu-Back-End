import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { CHALLENGE_PUBLIC_STATES, type ChallengePublicState } from './challenge.public';

const PUBLIC_STATE_FILTERS = ['ALL', ...CHALLENGE_PUBLIC_STATES] as const;
export type ChallengePublicStateFilter = (typeof PUBLIC_STATE_FILTERS)[number];

export class ChallengeDiscoveryQueryDto {
  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(PUBLIC_STATE_FILTERS) })
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsIn(PUBLIC_STATE_FILTERS)
  state?: ChallengePublicStateFilter;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 2, maxLength: 35 })
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  languageCode?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export type PublicChallengeState = ChallengePublicState;
