import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { CHALLENGE_PUBLIC_STATES, type ChallengePublicState } from './challenge.public';

const PUBLIC_STATE_FILTERS = ['ALL', ...CHALLENGE_PUBLIC_STATES] as const;
export type ChallengePublicStateFilter = (typeof PUBLIC_STATE_FILTERS)[number];

export class ChallengeDiscoveryQueryDto {
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsIn(PUBLIC_STATE_FILTERS)
  state?: ChallengePublicStateFilter;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString()
  @Length(2, 35)
  languageCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export type PublicChallengeState = ChallengePublicState;
