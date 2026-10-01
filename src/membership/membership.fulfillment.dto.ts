import { Type } from 'class-transformer';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

export class RedeemMembershipCreditDto {
  @IsUUID('4')
  planVersionId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  creditUnits!: number;
}
